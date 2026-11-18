import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";
import type { ThreadVerdict } from "./contract";

interface VerdictList {
  threads: ThreadVerdict[];
  judging: string[];
}

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
                answers: {
                  resolved: { type: "noul", noul: resolved ? 0.9 : 0.1 },
                  progress: { type: "score", score: resolved ? 4 : 2 },
                },
              }),
            );
        }),
    ),
  );
  return { answer: (resolved: boolean) => answer(resolved) };
}

async function start(events: object[] = []) {
  const thread = makeThreadResponse({ id: THREAD, status: "idle", updatedAt: Date.now() });
  const { bb, harness } = createFakePluginHost({
    pluginId: "thread-resolved",
    settings: { apiKey: "test-key" },
    sdk: {
      threads: {
        list: () => [{ ...thread, hasPendingInteraction: false, queuedWork: "none" }],
        experimental_listDescendants: () => ({ threads: [{ threadId: THREAD, descendantIds: [] }] }),
        events: { list: () => events },
        output: () => ({ output: null }),
      },
    },
  });
  await plugin(bb);
  const list = async () => (await harness.callRpc("verdict_list", null)) as VerdictList;
  const judging = async () => (await list()).judging;
  const resolved = async () => (await list()).threads.filter((t) => t.resolved).map((t) => t.threadId);
  return { harness, thread, list, judging, resolved };
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

describe("long threads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries with a shorter transcript when the model refuses the length", async () => {
    const states: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        states.push(JSON.parse(String(init.body)).state);
        return states.length === 1
          ? Response.json({ detail: { error_type: "max_tokens_exceeded" } }, { status: 400 })
          : Response.json({
              answers: { resolved: { type: "noul", noul: 0.8 }, progress: { type: "score", score: 4 } },
            });
      }),
    );
    const replies = Array.from({ length: 50 }, (_, seq) => ({
      type: "item/completed",
      seq,
      data: { item: { type: "agentMessage", text: "x".repeat(2_000) } },
    }));
    const { harness, resolved } = await start(replies);

    await harness.runCli(["check", THREAD]);

    expect(states).toHaveLength(2);
    expect(states[1]!.length).toBeLessThan(states[0]!.length);
    expect(await resolved()).toEqual([THREAD]);
  });
});

describe("progress", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports how much of an open thread is done, and keeps it out of the resolved list", async () => {
    const requests: { questions: Record<string, { type: string }> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({
          answers: { resolved: { type: "noul", noul: 0.2 }, progress: { type: "score", score: 3 } },
        });
      }),
    );
    const { harness, list } = await start();

    const status = await harness.runCli(["check", THREAD, "--json"]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.questions.progress!.type).toBe("score");
    expect(JSON.parse(status.stdout)).toMatchObject({ resolved: false, confidence: 0.2, progress: 0.75 });
    expect((await list()).threads).toMatchObject([{ threadId: THREAD, resolved: false, progress: 0.75 }]);
    expect(JSON.parse((await harness.runCli(["list", "--json"])).stdout)).toEqual([]);
  });
});
