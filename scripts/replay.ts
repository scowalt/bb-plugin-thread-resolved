// Re-judges threads with the question in this checkout, to see how a question
// change moves confidences and progress before it ships. Prints one JSON line per thread.
//
//   bb thread-resolved list --json | jq -r '.[].threadId' | npx tsx scripts/replay.ts
//   npx tsx scripts/replay.ts thr_abc123 thr_def456
//   npx tsx scripts/replay.ts --model opencode/jev-1.13-free thr_abc123   # another model than the setting
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  apiKeyFor,
  askVerdict,
  buildState,
  DEFAULT_DECISION_MODEL,
  parseDecisionModel,
  PROMPT_VERSION,
  type ModelConfig,
  type RelatedThread,
} from "../src/judge.ts";
import { buildTranscript, eventToEntry, mentionedThreadIds, type RawEvent } from "../src/transcript.ts";

const exec = promisify(execFile);
const TRANSCRIPT_BUDGET = 60_000;
const PARALLEL = 2;

async function bb<T>(...args: string[]): Promise<T> {
  const { stdout } = await exec("bb", [...args, "--json"], { maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

interface ShownThread {
  thread: { id: string; title: string | null; titleFallback: string | null; status: string; parentThreadId: string | null; archivedAt: number | null };
}

async function show(id: string): Promise<ShownThread["thread"] | null> {
  return bb<ShownThread>("thread", "show", id).then((shown) => shown.thread, () => null);
}

async function config(override: string | undefined): Promise<ModelConfig> {
  const settings = await bb<{ values?: Record<string, unknown> }>("plugin", "config", "thread-resolved").catch((): { values?: Record<string, unknown> } => ({}));
  const model = parseDecisionModel(override ?? String(settings.values?.decisionModel ?? DEFAULT_DECISION_MODEL));
  const auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8"));
  const apiKey = apiKeyFor(auth, model.provider);
  if (!apiKey) throw new Error("No API key in ~/.local/share/opencode/auth.json; log in with `opencode auth login`.");
  return { ...model, apiKey };
}

async function judge(id: string, children: Map<string, string[]>, model: ModelConfig) {
  const thread = await show(id);
  if (!thread) return { id, error: "not found" };
  const events = await bb<RawEvent[]>("thread", "log", id, "--all");
  const entries = events.map(eventToEntry).filter((entry): entry is string => entry !== null);
  const transcript = buildTranscript(entries, TRANSCRIPT_BUDGET);
  const parent = thread.parentThreadId === null ? [] : [thread.parentThreadId];
  const kids = children.get(id) ?? [];
  const mentions = mentionedThreadIds(transcript, id).filter((other) => !kids.includes(other) && !parent.includes(other));
  const related: RelatedThread[] = await Promise.all(
    [...parent, ...kids, ...mentions].slice(0, 25).map(async (other) => {
      const shown = await show(other);
      const output = shown ? await bb<{ output: string | null }>("thread", "output", other).catch(() => ({ output: null })) : { output: null };
      return {
        id: other,
        relation: parent.includes(other) ? "parent" : kids.includes(other) ? "child" : "mentioned",
        title: shown?.title ?? shown?.titleFallback ?? "(unknown)",
        state: shown === null ? "deleted" : shown.archivedAt !== null ? "archived" : shown.status,
        lastOutput: output.output ? output.output.replace(/\s+/g, " ").slice(-600) : null,
      } satisfies RelatedThread;
    }),
  );
  const state = buildState({ title: thread.title ?? thread.titleFallback ?? "(untitled)", transcript, related });
  const verdict = await askVerdict(model, state, AbortSignal.timeout(60_000), () => {});
  return { id, title: thread.title, prompt: PROMPT_VERSION, ...verdict };
}

const fromStdin = process.stdin.isTTY ? "" : await new Response(process.stdin as unknown as ReadableStream).text();
const args = process.argv.slice(2);
const modelFlag = args.indexOf("--model");
const modelOverride = modelFlag === -1 ? undefined : args[modelFlag + 1];
if (modelFlag !== -1 && !modelOverride) throw new Error("--model needs a value, such as opencode-go/jev-1.14");
const ids = [...args, ...fromStdin.split(/\s+/)].filter((id) => /^thr_/.test(id));
const listed = await bb<{ id: string; parentThreadId: string | null }[]>("thread", "list", "--include-archived");
const children = new Map<string, string[]>();
for (const thread of listed) {
  if (thread.parentThreadId) children.set(thread.parentThreadId, [...(children.get(thread.parentThreadId) ?? []), thread.id]);
}
const model = await config(modelOverride);
const queue = [...ids];
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const result = await judge(id, children, model).catch((error: unknown) => ({ id, error: String(error) }));
      console.log(JSON.stringify(result));
    }
  }),
);
