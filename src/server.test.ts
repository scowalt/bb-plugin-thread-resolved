import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";

const THREAD = "thr_aaaaaaaaaa";

/** A model call that stays open until the test answers it. */
function holdModel() {
  let answer: (resolved: boolean) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = (resolved) =>
            resolve(
              Response.json({
                choices: [{ message: { content: JSON.stringify({ resolved, reason: "test reason" }) } }],
              }),
            );
        }),
    ),
  );
  return { answer: (resolved: boolean) => answer(resolved) };
}

async function start() {
  const thread = makeThreadResponse({ id: THREAD, status: "idle", updatedAt: Date.now() });
  const { bb, harness } = createFakePluginHost({
    pluginId: "thread-resolved",
    settings: { apiKey: "test-key" },
    sdk: {
      threads: {
        list: () => [{ ...thread, hasPendingInteraction: false, queuedWork: "none" }],
        experimental_listDescendants: () => ({ threads: [{ threadId: THREAD, descendantIds: [] }] }),
        events: { list: () => [] },
        output: () => ({ output: null }),
      },
    },
  });
  await plugin(bb);
  const judging = async () => ((await harness.callRpc("resolved_list", null)) as { judging: string[] }).judging;
  const resolved = async () =>
    ((await harness.callRpc("resolved_list", null)) as { threads: { threadId: string }[] }).threads.map((t) => t.threadId);
  return { harness, thread, judging, resolved };
}

describe("judging state", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("covers the settle delay and the model call, then gives way to the verdict", async () => {
    const model = holdModel();
    const { harness, thread, judging, resolved } = await start();

    await harness.emitThreadEvent("thread.idle", { thread } as never);
    expect(await judging()).toEqual([THREAD]);

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(await judging()).toEqual([THREAD]);

    model.answer(true);
    await vi.waitFor(async () => expect(await judging()).toEqual([]));
    expect(await resolved()).toEqual([THREAD]);
  });

  it("covers a model call the sweep or CLI started without an idle event", async () => {
    const model = holdModel();
    const { harness, judging } = await start();
    expect(await judging()).toEqual([]);
    const done = harness.runCli(["check", THREAD]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(await judging()).toEqual([THREAD]);
    model.answer(false);
    await done;
    expect(await judging()).toEqual([]);
  });

  it("drops when the thread starts a new turn", async () => {
    holdModel();
    const { harness, thread, judging } = await start();
    await harness.emitThreadEvent("thread.idle", { thread } as never);
    expect(await judging()).toEqual([THREAD]);
    await harness.emitThreadEvent("thread.active", { thread: { ...thread, status: "active" } } as never);
    expect(await judging()).toEqual([]);
  });

  it("drops without a model call when nothing changed since the last verdict", async () => {
    const model = holdModel();
    const { harness, thread, judging } = await start();
    await harness.emitThreadEvent("thread.idle", { thread } as never);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    model.answer(false);
    await vi.waitFor(async () => expect(await judging()).toEqual([]));

    await harness.emitThreadEvent("thread.idle", { thread } as never);
    expect(await judging()).toEqual([THREAD]);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(async () => expect(await judging()).toEqual([]));
    expect(fetch).toHaveBeenCalledOnce();
  });
});
