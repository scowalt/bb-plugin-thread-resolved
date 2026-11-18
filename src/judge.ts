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

const INSTRUCTIONS = `The state is a thread in bb, an app where a person works with AI coding agents: one conversation between the person and an agent, plus the threads related to it. ${QUESTION}`;

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

/** Changes whenever the question does, so stored verdicts from an older question are judged again. */
export const PROMPT_VERSION = createHash("sha256")
  .update(JSON.stringify([INSTRUCTIONS, CRITERIA]))
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
  ) {
    super(message);
  }
}

export interface ModelConfig {
  apiKey: string;
  model: string;
}

const answerSchema = z.object({
  answers: z.object({ resolved: z.object({ noul: z.number().min(0).max(1) }) }),
});
const errorSchema = z.union([
  z.object({ error: z.object({ message: z.string() }) }).transform((body) => body.error.message),
  z.object({ detail: z.object({ error_type: z.string() }) }).transform((body) => body.detail.error_type),
]);

/** The probability, from 0 to 1, that the thread is resolved. */
export async function askConfidence(config: ModelConfig, state: string, signal: AbortSignal): Promise<number> {
  const response = await fetch(DECISION_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      state,
      questions: { resolved: { type: "noul", instructions: INSTRUCTIONS, criteria: CRITERIA } },
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    const message = error.success ? error.data : JSON.stringify(body)?.slice(0, 300);
    throw new ModelError(`${config.model} answered ${response.status}: ${message}`, response.status, message === "max_tokens_exceeded");
  }
  return answerSchema.parse(body).answers.resolved.noul;
}
