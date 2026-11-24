import { createHash } from "node:crypto";
import { z } from "zod";

export const QUESTION =
  "Is all of the work for this thread either resolved or picked up by another thread?";

export const DECISION_ENDPOINT = "https://opencode.ai/inference/systemone/v1/systemone";

export interface RelatedThread {
  id: string;
  relation: "parent" | "child" | "mentioned";
  title: string;
  /** idle, active, error, … or "archived" / "deleted". */
  state: string;
  lastOutput: string | null;
}

const INSTRUCTIONS = `The state is a thread in bb, an app where a person works with AI agents on any kind of task (coding, research, writing, planning, operations, questions): one conversation between the person and an agent, plus the threads related to it. ${QUESTION}`;

const CRITERIA = {
  true: `Every request the person made in the thread meets one of these:
- It was a question, research, a review, or an explanation, the agent answered it, and the answer leaves the person nothing to do.
- It was a change (code, config, content, infrastructure, anything that ships), and the change landed in production and was verified to work there. Landed means merged to the main branch and deployed, released, published, or installed, whichever way the project ships. Verified means the agent or the person checked the live result (loaded the deployed page, ran the released version, saw the production deploy succeed and the change behave as asked).
- The person dropped it, said it is fine as is, or said not to ship it.
- It was handed to another thread (a child thread, a spawned thread, or another thread that took it over), and that thread is running or has finished. The list of related threads shows their current state.
- This thread has a parent thread (a related thread marked parent) that started it for one part of a larger task, and this thread did that part and reported back. Shipping the result is then the parent's job. Without a parent, this rule does not apply.`,
  false: `Any of these holds:
- A change is written but not in production: uncommitted, committed but not pushed, on a branch, in an open or draft pull request, merged but not yet deployed or released. Passing tests, lint, or a local or preview run do not count as production.
- A change reached production but nobody checked that it works there.
- The agent's last message asks the person a question, offers options, or waits for a decision or approval.
- The agent says work remains, lists next steps it has not done, or stopped partway (an error, a limit, a blocker).
- The agent's answer gives the person things to do: suggested action items, a to-do list or unchecked checklist, tasks to file, follow-ups to send, or decisions and open questions to settle. This holds even when the person asked only for suggestions. It stays open until the person says each one is done, tracked elsewhere, or dropped, or another thread took them over.
- The agent promised to come back later and nothing else will do it.
- A request from the person has no answer yet.`,
};

const PROGRESS_INSTRUCTIONS =
  "The state is a thread in bb, where a person works with an AI agent on any kind of task: coding, research, writing, planning, operations, questions. How much of the work the person asked for in this thread is finished? Finished means the person has nothing left to do or wait for: questions answered, changes shipped and checked, or the work handed off or dropped.";

const PROGRESS_LEVELS = [
  "None of it is done",
  "Some of it is done; most of it remains",
  "Most of it is done, with a final step left: shipping, checking, a decision, or action items for the person",
  "All of it is done; the person has nothing left to do",
];

/** Changes whenever the questions do, so stored verdicts from older questions are judged again. */
export const PROMPT_VERSION = createHash("sha256")
  .update(JSON.stringify([INSTRUCTIONS, CRITERIA, PROGRESS_INSTRUCTIONS, PROGRESS_LEVELS]))
  .digest("hex")
  .slice(0, 12);

/** The thread as the decision model's state. */
export function buildState(input: { title: string; transcript: string; related: readonly RelatedThread[] }): string {
  const related =
    input.related.length === 0
      ? "(none)"
      : input.related
          .map((thread) => {
            const output = thread.lastOutput ? `\n  Last reply: ${thread.lastOutput}` : "";
            return `- @thread:${thread.id} (${thread.relation}) "${thread.title}": ${thread.state}${output}`;
          })
          .join("\n");
  return `Thread title: ${input.title}\n\nRelated threads:\n${related}\n\nThe thread, oldest first:\n\n${input.transcript}`;
}

/** The decision endpoint refused the call; `status` is its HTTP status. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly tooLong = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface ModelConfig {
  apiKey: string;
  model: string;
}

/** Both from 0 to 1. */
export interface Verdict {
  /** The probability that the thread's work is resolved. */
  confidence: number;
  /** The level of `PROGRESS_LEVELS` the model finds most likely, as 0, 1/3, 2/3 or 1. */
  progress: number;
}

const answerSchema = z.object({
  answers: z.object({
    resolved: z.object({ noul: z.number().min(0).max(1) }),
    progress: z.object({ probabilities: z.record(z.string(), z.number()) }),
  }),
});
const errorSchema = z.union([
  z.object({ error: z.object({ message: z.string() }) }).transform((body) => body.error.message),
  z.object({ detail: z.object({ error_type: z.string() }) }).transform((body) => body.detail.error_type),
]);

function retryAfterMs(header: string | null): number | null {
  return header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) * 1000 : null;
}

/** `onAnswered` runs when the response is 2xx, before its body is read: OpenCode bills every answered request. */
export async function askVerdict(
  config: ModelConfig,
  state: string,
  signal: AbortSignal,
  onAnswered: () => void,
): Promise<Verdict> {
  const response = await fetch(DECISION_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      state,
      questions: {
        resolved: { type: "noul", instructions: INSTRUCTIONS, criteria: CRITERIA },
        progress: { type: "score", instructions: PROGRESS_INSTRUCTIONS, criteria: PROGRESS_LEVELS },
      },
    }),
  });
  if (response.ok) onAnswered();
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    const message = error.success ? error.data : JSON.stringify(body)?.slice(0, 300);
    throw new ModelError(
      `${config.model} answered ${response.status}: ${message}`,
      response.status,
      message === "max_tokens_exceeded",
      retryAfterMs(response.headers.get("retry-after")),
    );
  }
  const { answers } = answerSchema.parse(body);
  const likelihood = (level: number) => answers.progress.probabilities[String(level)] ?? 0;
  const level = [...PROGRESS_LEVELS.keys()].reduce((best, next) => (likelihood(next) > likelihood(best) ? next : best));
  return { confidence: answers.resolved.noul, progress: level / (PROGRESS_LEVELS.length - 1) };
}
