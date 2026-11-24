// Thread Resolved: asks a decision model how likely it is that each idle
// thread's work is resolved or picked up by another thread, and how much of it
// is done, and publishes the verdicts so the app can draw a checkmark on
// threads above the threshold and a percentage on the rest.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { VERDICTS_CHANGED } from "./src/channels";
import { rpcContract, type ThreadVerdict } from "./src/contract";
import {
  askVerdict,
  buildState,
  ModelError,
  PROMPT_VERSION,
  type ModelConfig,
  type RelatedThread,
  type Verdict,
} from "./src/judge";
import {
  buildTranscript,
  eventToEntry,
  mentionedThreadIds,
  TRANSCRIPT_EVENT_TYPES,
  type RawEvent,
} from "./src/transcript";

const SWEEP_INTERVAL_MS = 60_000;
const IDLE_SETTLE_MS = 3_000;
const MAX_PARALLEL_CHECKS = 2;
const MAX_RELATED = 25;
const RETRY_AFTER_ERROR_MS = 10 * 60_000;
const RELATED_RECHECK_MS = 15 * 60_000;
const PAUSE_AFTER_RATE_LIMIT_MS = 5 * 60_000;
// The decision model reads at most 32k tokens; a thread too long at one
// budget is retried at the next.
const TRANSCRIPT_BUDGETS = [60_000, 30_000, 15_000];
const EVENT_PAGE = 100;

interface VerdictRow {
  thread_id: string;
  fingerprint: string;
  /** The probability that the thread is resolved; null when there is no current verdict. */
  confidence: number | null;
  /** How much of the work is done, from 0 to 1; null exactly when `confidence` is. */
  progress: number | null;
  checked_at: number;
  mentioned_ids: string;
  error: string | null;
  error_at: number | null;
}

type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    decisionModel: {
      type: "string",
      label: "Decision model",
      description: "OpenCode decision model id: jev-1.13-free, jev-1.13, gpt-6-luna-decision or gemini-decision-1.",
      default: "jev-1.13-free",
    },
    threshold: {
      type: "number",
      label: "Resolved at confidence",
      description: "A thread shows as resolved when the model's confidence is at least this, from 0 to 1.",
      experimental_schema: z.number().min(0).max(1),
      default: 0.7,
    },
    apiKey: {
      type: "string",
      label: "API key",
      description: "Leave empty to use the key OpenCode saved in ~/.local/share/opencode/auth.json.",
      secret: true,
    },
    lookbackDays: {
      type: "number",
      label: "Check threads active in the last N days",
      experimental_schema: z.number().int().min(1).max(365),
      default: 3,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS verdicts (
      thread_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      resolved INTEGER NOT NULL,
      reason TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      mentioned_ids TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      error_at INTEGER
    )`,
    "DROP TABLE verdicts",
    `CREATE TABLE verdicts (
      thread_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      confidence REAL,
      checked_at INTEGER NOT NULL,
      mentioned_ids TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      error_at INTEGER
    )`,
    "ALTER TABLE verdicts ADD COLUMN progress REAL",
    "UPDATE verdicts SET confidence = NULL, fingerprint = '' WHERE progress IS NULL",
  ]);
  const getRow = db.prepare<[string], VerdictRow>("SELECT * FROM verdicts WHERE thread_id = ?");
  const upsertRow = db.prepare(
    `INSERT INTO verdicts (thread_id, fingerprint, confidence, progress, checked_at, mentioned_ids, error, error_at)
     VALUES (@thread_id, @fingerprint, @confidence, @progress, @checked_at, @mentioned_ids, NULL, NULL)
     ON CONFLICT(thread_id) DO UPDATE SET fingerprint = excluded.fingerprint, confidence = excluded.confidence,
       progress = excluded.progress, checked_at = excluded.checked_at, mentioned_ids = excluded.mentioned_ids, error = NULL, error_at = NULL`,
  );
  const recordError = db.prepare(
    `INSERT INTO verdicts (thread_id, fingerprint, confidence, progress, checked_at, error, error_at)
     VALUES (?, '', NULL, NULL, 0, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`,
  );
  const unresolve = db.prepare(
    "UPDATE verdicts SET confidence = NULL, progress = NULL, fingerprint = '' WHERE thread_id = ? AND confidence IS NOT NULL",
  );
  const deleteRow = db.prepare("DELETE FROM verdicts WHERE thread_id = ?");
  const listJudged = db.prepare<[], VerdictRow>("SELECT * FROM verdicts WHERE confidence IS NOT NULL");

  const changed = () => bb.realtime.publish(VERDICTS_CHANGED, null);

  // Idle threads whose verdict is on its way: settling after a turn ended, or
  // past the fingerprint check with a model call in flight. Memory only; a
  // restart drops it and the next check re-adds what still needs judging.
  const judging = new Set<string>();
  function setJudging(threadId: string, on: boolean) {
    if (judging.has(threadId) === on) return;
    if (on) judging.add(threadId);
    else judging.delete(threadId);
    changed();
  }

  function clearVerdict(threadId: string) {
    setJudging(threadId, false);
    if (unresolve.run(threadId).changes > 0) changed();
  }
  function forgetThread(threadId: string) {
    setJudging(threadId, false);
    const row = getRow.get(threadId);
    deleteRow.run(threadId);
    if (row?.confidence != null) changed();
  }

  async function modelConfig(): Promise<ModelConfig> {
    const { decisionModel: model, apiKey } = await settings.get();
    if (apiKey) return { model, apiKey };
    const auth = z
      .record(z.string(), z.object({ key: z.string().optional() }))
      .parse(JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8")));
    const key = auth.opencode?.key ?? auth["opencode-go"]?.key;
    if (!key) throw new Error("No API key: set apiKey, or log in to OpenCode with `opencode auth login`.");
    return { model, apiKey: key };
  }

  async function listThreads(ids: readonly string[], archived: boolean): Promise<ListedThread[]> {
    if (ids.length === 0) return [];
    return bb.sdk.threads.list({ threadIds: ids.slice(0, 200), includeHidden: true, archived });
  }

  /** Each related thread as it is now, or null once deleted. */
  async function relatedStates(ids: readonly string[]): Promise<Map<string, ListedThread | null>> {
    const found = [...(await listThreads(ids, false)), ...(await listThreads(ids, true))];
    return new Map(ids.map((id) => [id, found.find((thread) => thread.id === id) ?? null]));
  }
  function stateOf(thread: ListedThread | null): string {
    if (thread === null) return "deleted";
    if (thread.archivedAt !== null) return "archived";
    return thread.hasPendingInteraction ? `${thread.status}, waiting on the person` : thread.status;
  }
  /**
   * What a verdict depends on. latestAttentionAt moves when a turn ends, while
   * updatedAt also moves when the person reads the thread. A related thread
   * starting a turn changes nothing here; its turn ending does, so a parent is
   * judged once per child turn, with the child's finished work in view.
   */
  function fingerprint(thread: ListedThread, related: Map<string, ListedThread | null>): string {
    const parts = [...related]
      .filter(([id]) => id !== thread.parentThreadId)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, t]) => `${id}=${t === null ? "deleted" : `${t.latestAttentionAt},${t.archivedAt !== null},${t.hasPendingInteraction}`}`);
    return [ownFingerprint(thread), ...parts].join("|");
  }

  function ownFingerprint(thread: ListedThread): string {
    return `${PROMPT_VERSION}|${thread.latestAttentionAt}`;
  }

  async function childIds(threadId: string): Promise<string[]> {
    const { threads } = await bb.sdk.threads.experimental_listDescendants({
      threadIds: [threadId],
      includeArchived: true,
      includeHidden: true,
    });
    return threads[0]?.descendantIds ?? [];
  }

  async function readEntries(threadId: string, signal: AbortSignal): Promise<string[]> {
    const entries: string[] = [];
    let afterSeq: number | undefined;
    for (;;) {
      const page = await bb.sdk.threads.events.list({
        threadId,
        types: TRANSCRIPT_EVENT_TYPES,
        limit: String(EVENT_PAGE),
        order: "asc",
        signal,
        ...(afterSeq === undefined ? {} : { afterSeq: String(afterSeq) }),
      });
      for (const event of page as RawEvent[]) {
        const entry = eventToEntry(event);
        if (entry !== null) entries.push(entry);
      }
      if (page.length < EVENT_PAGE) break;
      afterSeq = page[page.length - 1]?.seq;
    }
    return entries;
  }

  /** The verdict for the longest transcript the model accepts. */
  async function askAtBudgets(
    entries: readonly string[],
    stateFor: (transcript: string) => string,
    signal: AbortSignal,
  ): Promise<Verdict> {
    const config = await modelConfig();
    for (const [index, budget] of TRANSCRIPT_BUDGETS.entries()) {
      try {
        return await askVerdict(config, stateFor(buildTranscript(entries, budget)), signal);
      } catch (error) {
        if (!(error instanceof ModelError && error.tooLong) || index === TRANSCRIPT_BUDGETS.length - 1) throw error;
      }
    }
    throw new Error("unreachable");
  }

  /** Re-judge one thread when it or a related thread changed since the last verdict. */
  async function check(threadId: string, signal: AbortSignal, force = false): Promise<VerdictRow | null> {
    try {
      return await judge(threadId, signal, force);
    } finally {
      setJudging(threadId, false);
    }
  }

  async function judge(threadId: string, signal: AbortSignal, force: boolean): Promise<VerdictRow | null> {
    const [thread] = await listThreads([threadId], false);
    if (!thread || thread.deletedAt !== null) {
      forgetThread(threadId);
      return null;
    }
    if (thread.status !== "idle" || thread.hasPendingInteraction || thread.queuedWork !== "none") {
      clearVerdict(threadId);
      return getRow.get(threadId) ?? null;
    }
    const previous = getRow.get(threadId);
    const children = await childIds(threadId);
    const previousMentions = z.array(z.string()).catch([]).parse(JSON.parse(previous?.mentioned_ids ?? "[]"));
    const parent = thread.parentThreadId === null ? [] : [thread.parentThreadId];
    const cheap = fingerprint(
      thread,
      await relatedStates([...new Set([...parent, ...children, ...previousMentions])].slice(0, MAX_RELATED)),
    );
    if (!force && previous) {
      if (previous.fingerprint === cheap) return previous;
      if (previous.error_at !== null && Date.now() - previous.error_at < RETRY_AFTER_ERROR_MS) return previous;
      const sameTurn = `${previous.fingerprint}|`.startsWith(`${ownFingerprint(thread)}|`);
      if (sameTurn && Date.now() - previous.checked_at < RELATED_RECHECK_MS) return previous;
    }
    setJudging(threadId, true);

    const entries = await readEntries(threadId, signal);
    const mentions = mentionedThreadIds(buildTranscript(entries, TRANSCRIPT_BUDGETS[0]!), threadId).filter((id) => !children.includes(id) && !parent.includes(id));
    const relatedIds = [...parent, ...children, ...mentions].slice(0, MAX_RELATED);
    const states = await relatedStates(relatedIds);
    const related: RelatedThread[] = await Promise.all(
      relatedIds.map(async (id) => {
        const other = states.get(id) ?? null;
        const output = other ? (await bb.sdk.threads.output({ threadId: id, signal })).output : null;
        return {
          id,
          relation: parent.includes(id) ? "parent" : children.includes(id) ? "child" : "mentioned",
          title: other?.title ?? other?.titleFallback ?? "(unknown)",
          state: stateOf(other),
          lastOutput: output ? output.replace(/\s+/g, " ").slice(-600) : null,
        } satisfies RelatedThread;
      }),
    );
    const title = thread.title ?? thread.titleFallback ?? "(untitled)";

    try {
      const { confidence, progress } = await askAtBudgets(
        entries,
        (transcript) => buildState({ title, transcript, related }),
        signal,
      );
      upsertRow.run({
        thread_id: threadId,
        fingerprint: fingerprint(thread, states),
        confidence,
        progress,
        checked_at: Date.now(),
        mentioned_ids: JSON.stringify(mentions.filter((id) => relatedIds.includes(id))),
      });
      changed();
      bb.log.info(
        `judged ${threadId}: ${Math.round(confidence * 100)}% resolved, ${Math.round(progress * 100)}% done`,
      );
      return getRow.get(threadId) ?? null;
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      recordError.run(threadId, message, Date.now());
      if (error instanceof ModelError && error.status === 429) pauseUntil(Date.now() + PAUSE_AFTER_RATE_LIMIT_MS);
      bb.log.warn(`check of ${threadId} failed: ${message}`);
      return getRow.get(threadId) ?? null;
    }
  }

  // A small queue: each thread at most once, a couple of model calls at a time.
  // Threads an event just touched go before the sweep's backlog.
  const urgent = new Set<string>();
  const pending = new Set<string>();
  const running = new Set<string>();
  const stopping = new AbortController();
  bb.onDispose(() => stopping.abort());

  let pausedUntil = 0;
  function pauseUntil(time: number) {
    pausedUntil = time;
    bb.log.warn(`rate limited; pausing checks until ${new Date(time).toISOString()}`);
    const timer = setTimeout(pump, time - Date.now());
    stopping.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }

  function pump() {
    for (const threadId of [...urgent, ...pending]) {
      if (running.size >= MAX_PARALLEL_CHECKS || stopping.signal.aborted || Date.now() < pausedUntil) return;
      if (running.has(threadId)) continue;
      urgent.delete(threadId);
      pending.delete(threadId);
      running.add(threadId);
      check(threadId, stopping.signal)
        .catch((error) => {
          if (!stopping.signal.aborted) bb.log.warn(`check of ${threadId} crashed: ${String(error)}`);
        })
        .finally(() => {
          running.delete(threadId);
          pump();
        });
    }
  }
  function enqueue(threadId: string | null | undefined, { urgent: isUrgent = true, delayMs = 0 } = {}) {
    if (!threadId) return;
    const add = () => {
      (isUrgent ? urgent : pending).add(threadId);
      pump();
    };
    if (delayMs === 0) return add();
    const timer = setTimeout(add, delayMs);
    stopping.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }

  bb.events.on("thread.active", ({ thread }) => clearVerdict(thread.id));
  bb.events.on("thread.failed", ({ thread }) => clearVerdict(thread.id));
  bb.events.on("interaction.pending", ({ thread }) => clearVerdict(thread.id));
  bb.events.on("thread.idle", ({ thread }) => {
    setJudging(thread.id, true);
    enqueue(thread.id, { delayMs: IDLE_SETTLE_MS });
    enqueue(thread.parentThreadId, { delayMs: IDLE_SETTLE_MS });
  });
  bb.events.on("thread.archived", ({ thread }) => {
    forgetThread(thread.id);
    enqueue(thread.parentThreadId);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    forgetThread(thread.id);
    enqueue(thread.parentThreadId);
  });

  // The sweep re-asks about every recent idle thread whose fingerprint moved,
  // which catches a thread mentioned in another one
  // finishing, and anything the events above missed.
  bb.background.service("sweep", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const { lookbackDays } = await settings.get();
          const since = Date.now() - lookbackDays * 86_400_000;
          for (let offset = 0; ; offset += 200) {
            const page = await bb.sdk.threads.list({ limit: 200, offset, signal });
            for (const thread of page) {
              if (thread.updatedAt >= since && thread.visibility === "visible") enqueue(thread.id, { urgent: false });
            }
            if (page.length < 200) break;
          }
        } catch (error) {
          if (!signal.aborted) bb.log.warn(`sweep failed: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SWEEP_INTERVAL_MS);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
      }
    },
  });

  async function judgedThreads(): Promise<ThreadVerdict[]> {
    const { threshold } = await settings.get();
    return listJudged.all().flatMap((row) =>
      row.confidence === null || row.progress === null
        ? []
        : [
            {
              threadId: row.thread_id,
              resolved: row.confidence >= threshold,
              confidence: row.confidence,
              progress: row.progress,
              checkedAt: row.checked_at,
            },
          ],
    );
  }

  bb.rpc.register(rpcContract, {
    verdict_list: async () => ({ threads: await judgedThreads(), judging: [...judging] }),
  });

  const usage = [
    "Usage:",
    "  bb thread-resolved list [--json]             Threads judged resolved",
    "  bb thread-resolved judging [--json]          Threads awaiting a fresh verdict",
    "  bb thread-resolved status <thread-id> [--json]  The stored verdict for a thread",
    "  bb thread-resolved check <thread-id> [--json]   Ask the model now, ignoring the cache",
  ].join("\n");
  async function describe(row: VerdictRow | null | undefined): Promise<Record<string, unknown>> {
    if (!row) return { verdict: "none" };
    const { threshold } = await settings.get();
    return {
      threadId: row.thread_id,
      judging: judging.has(row.thread_id),
      resolved: row.confidence !== null && row.confidence >= threshold,
      confidence: row.confidence,
      progress: row.progress,
      checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null,
      error: row.error,
    };
  }
  bb.cli.register({
    name: "thread-resolved",
    summary: "See which threads the model judged resolved, or re-check one",
    commands: [
      { name: "list", summary: "Threads judged resolved", usage: "bb thread-resolved list [--json]" },
      { name: "judging", summary: "Threads awaiting a fresh verdict", usage: "bb thread-resolved judging [--json]" },
      { name: "status", summary: "The stored verdict for a thread", usage: "bb thread-resolved status <thread-id> [--json]" },
      { name: "check", summary: "Ask the model about a thread now", usage: "bb thread-resolved check <thread-id> [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, threadId, ...rest] = argv.filter((arg) => arg !== "--json");
      const reply = (value: unknown) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : JSON.stringify(value, null, 2),
      });
      if (command === "list" && threadId === undefined) {
        return reply((await judgedThreads()).filter((verdict) => verdict.resolved));
      }
      if (command === "judging" && threadId === undefined) return reply([...judging]);
      if (threadId !== undefined && rest.length === 0) {
        if (command === "status") return reply(await describe(getRow.get(threadId)));
        if (command === "check") return reply(await describe(await check(threadId, stopping.signal, true)));
      }
      return { exitCode: command === undefined || command === "help" ? 0 : 1, stdout: usage };
    },
  });
}
