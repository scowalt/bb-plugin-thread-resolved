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
                  progress: { type: "score", probabilities: resolved ? { 3: 0.9, 2: 0.1 } : { 1: 0.6, 2: 0.4 } },
                },
              }),
            );
        }),
    ),
  );
  return { answer: (resolved: boolean) => answer(resolved) };
}

const CHILD = "thr_bbbbbbbbbb";

type Listed = ReturnType<typeof makeThreadResponse> & { hasPendingInteraction: boolean; queuedWork: "none" };
const listed = (id: string, parentThreadId: string | null = null): Listed => ({
  ...makeThreadResponse({ id, parentThreadId, status: "idle", updatedAt: 1, latestAttentionAt: 1, title: id === CHILD ? "Child" : "Parent" }),
  hasPendingInteraction: false,
  queuedWork: "none",
});

/** THREAD, or THREAD with CHILD under it; tests change the threads in place. */
async function start(events: object[] = [], withChild = false, settings: Record<string, unknown> = {}) {
  const threads = new Map([[THREAD, listed(THREAD)]]);
  if (withChild) threads.set(CHILD, listed(CHILD, THREAD));
  const thread = threads.get(THREAD)!;
  const { bb, harness } = createFakePluginHost({
    pluginId: "thread-resolved",
    settings: { apiKey: "test-key", ...settings },
    sdk: {
      threads: {
        list: (args) =>
          args?.archived ? [] : [...threads.values()].filter((t) => args?.threadIds?.includes(t.id) ?? true),
        experimental_listDescendants: (args) => ({
          threads: (args?.threadIds ?? []).map((threadId: string) => ({
            threadId,
            descendantIds: withChild && threadId === THREAD ? [CHILD] : [],
          })),
        }),
        events: { list: () => events },
        output: () => ({ output: null }),
      },
    },
  });
  await plugin(bb);
  const list = async () => (await harness.callRpc("verdict_list", null)) as VerdictList;
  const judging = async () => (await list()).judging;
  const resolved = async () => (await list()).threads.filter((t) => t.resolved).map((t) => t.threadId);
  return { harness, thread, threads, list, judging, resolved };
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
              answers: { resolved: { type: "noul", noul: 0.8 }, progress: { type: "score", probabilities: { 3: 1 } } },
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

  it("reports the most likely third of an open thread done, and keeps it out of the resolved list", async () => {
    const requests: { questions: Record<string, { type: string }> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({
          answers: { resolved: { type: "noul", noul: 0.2 }, progress: { type: "score", score: 2.4, probabilities: { 1: 0.2, 2: 0.5, 3: 0.3 } } },
        });
      }),
    );
    const { harness, list } = await start();

    const status = await harness.runCli(["check", THREAD, "--json"]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.questions.progress!.type).toBe("score");
    expect(JSON.parse(status.stdout)).toMatchObject({ resolved: false, confidence: 0.2, progress: 2 / 3 });
    expect((await list()).threads).toMatchObject([{ threadId: THREAD, resolved: false, progress: 2 / 3 }]);
    expect(JSON.parse((await harness.runCli(["list", "--json"])).stdout)).toEqual([]);
  });
});

describe("when a thread is judged again", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          answers: { resolved: { type: "noul", noul: 0.2 }, progress: { type: "score", probabilities: { 2: 1 } } },
        }),
      ),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("skips reads and a child's turn starting, and judges once when the child's turn ends", async () => {
    const { harness, thread, threads, judging } = await start([], true);
    const settle = async (calls: number) => {
      await harness.emitThreadEvent("thread.idle", { thread } as never);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(async () => expect(await judging()).toEqual([]));
      expect(fetch).toHaveBeenCalledTimes(calls);
    };
    const child = threads.get(CHILD)!;

    await settle(1);

    threads.set(THREAD, { ...thread, updatedAt: 2, lastReadAt: 2 });
    await settle(1);

    threads.set(CHILD, { ...child, status: "active", updatedAt: 3 });
    await settle(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    threads.set(CHILD, { ...child, updatedAt: 4, latestAttentionAt: 4 });
    await settle(2);
  });

  it("asks about a thread again for a related thread's change at most every 15 minutes, and at once for its own turn", async () => {
    const { harness, thread, threads, judging } = await start([], true);
    const settle = async (calls: number) => {
      await harness.emitThreadEvent("thread.idle", { thread: threads.get(THREAD) } as never);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(async () => expect(await judging()).toEqual([]));
      expect(fetch).toHaveBeenCalledTimes(calls);
    };
    const child = threads.get(CHILD)!;

    await settle(1);

    threads.set(CHILD, { ...child, latestAttentionAt: 4 });
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await settle(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await settle(2);

    threads.set(CHILD, { ...child, latestAttentionAt: 5 });
    threads.set(THREAD, { ...thread, latestAttentionAt: 6 });
    await settle(3);
  });

  const askedAbout = (title: string) =>
    vi.mocked(fetch).mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).state.startsWith(`Thread title: ${title}\n`)).length;

  it("does not ask about a child again when only its parent finished a turn", async () => {
    const { harness, thread, threads, judging } = await start([], true);
    const child = threads.get(CHILD)!;
    const settle = async () => {
      await harness.emitThreadEvent("thread.idle", { thread: threads.get(CHILD) } as never);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(async () => expect(await judging()).toEqual([]));
    };

    await settle();
    expect(askedAbout("Child")).toBe(1);

    await vi.advanceTimersByTimeAsync(16 * 60_000);
    threads.set(THREAD, { ...thread, latestAttentionAt: 2 });
    await settle();
    expect(askedAbout("Child")).toBe(1);

    threads.set(CHILD, { ...child, latestAttentionAt: 3 });
    await settle();
    expect(askedAbout("Child")).toBe(2);
  });
});

describe("call limits", () => {
  const OTHER = "thr_cccccccccc";
  const answer = () =>
    Response.json({ answers: { resolved: { type: "noul", noul: 0.2 }, progress: { type: "score", probabilities: { 2: 1 } } } });
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function finishTurn(
    harness: Awaited<ReturnType<typeof start>>["harness"],
    threads: Map<string, Listed>,
    id: string,
    attentionAt: number,
  ) {
    const next = { ...threads.get(id)!, latestAttentionAt: attentionAt };
    threads.set(id, next);
    await harness.emitThreadEvent("thread.idle", { thread: next } as never);
    await vi.advanceTimersByTimeAsync(3_000);
  }

  it("asks at most checksPerDay times in 24 hours, and keeps counting across a reload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer()));
    const { harness, threads } = await start([], false, { checksPerDay: 1 });

    await finishTurn(harness, threads, THREAD, 2);
    expect(fetch).toHaveBeenCalledTimes(1);

    await finishTurn(harness, threads, THREAD, 3);
    expect(fetch).toHaveBeenCalledTimes(1);

    const reloaded = await harness.reload(plugin);
    await finishTurn(reloaded.harness, threads, THREAD, 4);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await finishTurn(reloaded.harness, threads, THREAD, 5);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, "a rate limit"],
    [402, "no credit left"],
    [451, "a refusal"],
    [503, "an outage"],
  ])("pauses every check for the Retry-After of a %i (%s)", async (status) => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { message: "slow down" } }, { status, headers: { "retry-after": "120" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { harness, threads } = await start();
    threads.set(OTHER, listed(OTHER));

    await finishTurn(harness, threads, THREAD, 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const pausedAt = Date.now();
    fetchMock.mockImplementation(async () => answer());

    await finishTurn(harness, threads, OTHER, 2);
    await vi.advanceTimersByTimeAsync(pausedAt + 119_000 - Date.now());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not count refused calls against checksPerDay", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: { message: "unavailable" } }, { status: 503, headers: { "retry-after": "120" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { harness, threads } = await start([], false, { checksPerDay: 1 });
    threads.set(OTHER, listed(OTHER));

    await finishTurn(harness, threads, THREAD, 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const refusedAt = Date.now();
    fetchMock.mockImplementation(async () => answer());

    await finishTurn(harness, threads, OTHER, 2);
    await vi.advanceTimersByTimeAsync(refusedAt + 120_000 - Date.now());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await finishTurn(harness, threads, THREAD, 3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
