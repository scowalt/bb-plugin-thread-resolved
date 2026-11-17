// Thread Resolved: asks a small model whether each idle thread's work is
// resolved or picked up by another thread, and publishes the threads where
// the answer is yes so the app can draw a checkmark on them.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { VERDICTS_CHANGED } from "./src/channels";
import { rpcContract, type ResolvedThread } from "./src/contract";
import { askModel, buildPrompt, ModelError, PROMPT_VERSION, type ModelConfig, type RelatedThread } from "./src/judge";
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
const PAUSE_AFTER_RATE_LIMIT_MS = 5 * 60_000;
const TRANSCRIPT_BUDGET = 100_000;
const EVENT_PAGE = 100;

interface VerdictRow {
  thread_id: string;
  fingerprint: string;
  resolved: number;
  reason: string;
  checked_at: number;
  mentioned_ids: string;
  error: string | null;
  error_at: number | null;
}

type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    model: {
      type: "string",
      label: "Model",
      description: "OpenCode model id that answers the question, such as hy4-flash-free or beam-free.",
      default: "hy4-flash-free",
    },
    baseUrl: {
      type: "string",
      label: "API base URL",
      description: "OpenAI-compatible endpoint. OpenCode Go is https://opencode.ai/zen/go/v1; Zen is https://opencode.ai/zen/v1.",
      default: "https://opencode.ai/zen/go/v1",
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
  ]);
  const getRow = db.prepare<[string], VerdictRow>("SELECT * FROM verdicts WHERE thread_id = ?");
  const upsertRow = db.prepare(
    `INSERT INTO verdicts (thread_id, fingerprint, resolved, reason, checked_at, mentioned_ids, error, error_at)
     VALUES (@thread_id, @fingerprint, @resolved, @reason, @checked_at, @mentioned_ids, NULL, NULL)
     ON CONFLICT(thread_id) DO UPDATE SET fingerprint = excluded.fingerprint, resolved = excluded.resolved,
       reason = excluded.reason, checked_at = excluded.checked_at, mentioned_ids = excluded.mentioned_ids,
       error = NULL, error_at = NULL`,
  );
  const recordError = db.prepare(
    `INSERT INTO verdicts (thread_id, fingerprint, resolved, reason, checked_at, error, error_at)
     VALUES (?, '', 0, '', 0, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`,
  );
  const unresolve = db.prepare("UPDATE verdicts SET resolved = 0, fingerprint = '' WHERE thread_id = ? AND resolved = 1");
  const deleteRow = db.prepare("DELETE FROM verdicts WHERE thread_id = ?");
  const listResolved = db.prepare<[], VerdictRow>("SELECT * FROM verdicts WHERE resolved = 1");

  const changed = () => bb.realtime.publish(VERDICTS_CHANGED, null);

  function clearVerdict(threadId: string) {
    if (unresolve.run(threadId).changes > 0) changed();
  }
  function forgetThread(threadId: string) {
    const row = getRow.get(threadId);
    deleteRow.run(threadId);
    if (row?.resolved) changed();
  }

  async function modelConfig(): Promise<ModelConfig> {
    const { model, baseUrl, apiKey } = await settings.get();
    if (apiKey) return { model, baseUrl, apiKey };
    const auth = z
      .record(z.string(), z.object({ key: z.string().optional() }))
      .parse(JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8")));
    const key = (baseUrl.includes("/zen/go") ? auth["opencode-go"] : auth.opencode)?.key;
    if (!key) throw new Error("No API key: set apiKey, or log in to OpenCode with `opencode auth login`.");
    return { model, baseUrl, apiKey: key };
  }

  async function listThreads(ids: readonly string[], archived: boolean): Promise<ListedThread[]> {
    if (ids.length === 0) return [];
    return bb.sdk.threads.list({ threadIds: ids.slice(0, 200), includeHidden: true, archived });
  }

  /** Each related thread's state; status changes (not every event) re-trigger a check. */
  async function relatedStates(ids: readonly string[]): Promise<Map<string, ListedThread | null>> {
    const found = [...(await listThreads(ids, false)), ...(await listThreads(ids, true))];
    return new Map(ids.map((id) => [id, found.find((thread) => thread.id === id) ?? null]));
  }
  function stateOf(thread: ListedThread | null): string {
    if (thread === null) return "deleted";
    if (thread.archivedAt !== null) return "archived";
    return thread.hasPendingInteraction ? `${thread.status}, waiting on the person` : thread.status;
  }
  function fingerprint(thread: ListedThread, related: Map<string, ListedThread | null>): string {
    const parts = [...related].sort(([a], [b]) => a.localeCompare(b)).map(([id, t]) => `${id}=${stateOf(t)}`);
    return [PROMPT_VERSION, String(thread.updatedAt), ...parts].join("|");
  }

  async function childIds(threadId: string): Promise<string[]> {
    const { threads } = await bb.sdk.threads.experimental_listDescendants({
      threadIds: [threadId],
      includeArchived: true,
      includeHidden: true,
    });
    return threads[0]?.descendantIds ?? [];
  }

  async function readTranscript(threadId: string, signal: AbortSignal): Promise<string> {
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
    return buildTranscript(entries, TRANSCRIPT_BUDGET);
  }

  /** Re-judge one thread when it or a related thread changed since the last verdict. */
  async function check(threadId: string, signal: AbortSignal, force = false): Promise<VerdictRow | null> {
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
    const cheap = fingerprint(thread, await relatedStates([...new Set([...children, ...previousMentions])].slice(0, MAX_RELATED)));
    if (!force && previous) {
      if (previous.fingerprint === cheap) return previous;
      if (previous.error_at !== null && Date.now() - previous.error_at < RETRY_AFTER_ERROR_MS) return previous;
    }

    const transcript = await readTranscript(threadId, signal);
    const mentions = mentionedThreadIds(transcript, threadId).filter((id) => !children.includes(id));
    const relatedIds = [...children, ...mentions].slice(0, MAX_RELATED);
    const states = await relatedStates(relatedIds);
    const related: RelatedThread[] = await Promise.all(
      relatedIds.map(async (id) => {
        const other = states.get(id) ?? null;
        const output = other ? (await bb.sdk.threads.output({ threadId: id, signal })).output : null;
        return {
          id,
          relation: children.includes(id) ? "child" : "mentioned",
          title: other?.title ?? other?.titleFallback ?? "(unknown)",
          state: stateOf(other),
          lastOutput: output ? output.replace(/\s+/g, " ").slice(-600) : null,
        } satisfies RelatedThread;
      }),
    );
    const prompt = buildPrompt({ title: thread.title ?? thread.titleFallback ?? "(untitled)", transcript, related });

    try {
      const verdict = await askModel(await modelConfig(), prompt, `thread-resolved-${threadId}`, signal);
      const row = {
        thread_id: threadId,
        fingerprint: fingerprint(thread, states),
        resolved: verdict.resolved ? 1 : 0,
        reason: verdict.reason,
        checked_at: Date.now(),
        mentioned_ids: JSON.stringify(mentions.filter((id) => relatedIds.includes(id))),
      };
      upsertRow.run(row);
      if (Boolean(previous?.resolved) !== verdict.resolved || verdict.resolved) changed();
      bb.log.info(`judged ${threadId}: ${verdict.resolved ? "resolved" : "open"} (${verdict.reason})`);
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

  // The sweep re-asks about every recent idle thread whose own or related
  // threads' state moved, which catches a thread mentioned in another one
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

  function resolvedThreads(): ResolvedThread[] {
    return listResolved.all().map((row) => ({ threadId: row.thread_id, reason: row.reason, checkedAt: row.checked_at }));
  }

  bb.rpc.register(rpcContract, {
    resolved_list: () => ({ threads: resolvedThreads() }),
  });

  const usage = [
    "Usage:",
    "  bb thread-resolved list [--json]             Threads judged resolved",
    "  bb thread-resolved status <thread-id> [--json]  The stored verdict for a thread",
    "  bb thread-resolved check <thread-id> [--json]   Ask the model now, ignoring the cache",
  ].join("\n");
  function describe(row: VerdictRow | null | undefined): Record<string, unknown> {
    if (!row) return { verdict: "none" };
    return {
      threadId: row.thread_id,
      resolved: row.resolved === 1,
      reason: row.reason,
      checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null,
      error: row.error,
    };
  }
  bb.cli.register({
    name: "thread-resolved",
    summary: "See which threads the model judged resolved, or re-check one",
    commands: [
      { name: "list", summary: "Threads judged resolved", usage: "bb thread-resolved list [--json]" },
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
      if (command === "list" && threadId === undefined) return reply(resolvedThreads());
      if (threadId !== undefined && rest.length === 0) {
        if (command === "status") return reply(describe(getRow.get(threadId)));
        if (command === "check") return reply(describe(await check(threadId, stopping.signal, true)));
      }
      return { exitCode: command === undefined || command === "help" ? 0 : 1, stdout: usage };
    },
  });
}
