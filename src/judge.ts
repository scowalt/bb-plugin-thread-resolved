import { z } from "zod";

export const QUESTION =
  "Is all of the work for this thread either resolved or picked up by another thread?";

export interface RelatedThread {
  id: string;
  relation: "child" | "mentioned";
  title: string;
  /** idle, active, error, … or "archived" / "deleted". */
  state: string;
  lastOutput: string | null;
}

export interface Verdict {
  resolved: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You review threads in bb, an app where a person works with AI coding agents. Each thread is one conversation between the person and an agent. You decide whether the thread still needs the person's attention.

Answer this question about the thread: "${QUESTION}"

Answer yes (resolved: true) only when one of these holds for every request the person made in the thread:
- The agent finished it and reported the result, and nothing is waiting on the person.
- The person dropped it, or said it is fine as is.
- It was handed to another thread (a child thread, a spawned thread, or another thread that took it over), and that thread is running or has finished. The list of related threads shows their current state.

Answer no (resolved: false) when any of these holds:
- The agent's last message asks the person a question, offers options, or waits for a decision or approval.
- The agent says work remains, lists next steps it has not done, or stopped partway (an error, a limit, a blocker).
- The agent promised to come back later and nothing else will do it.
- A request from the person has no answer yet.
- You are unsure.

Reply with only a JSON object, no other text: {"resolved": true or false, "reason": "<one short sentence, at most 20 words, naming what is done or what is still open>"}`;

export function buildPrompt(input: {
  title: string;
  transcript: string;
  related: readonly RelatedThread[];
}): { system: string; user: string } {
  const related =
    input.related.length === 0
      ? "(none)"
      : input.related
          .map((thread) => {
            const output = thread.lastOutput ? `\n  Last reply: ${thread.lastOutput}` : "";
            return `- @thread:${thread.id} (${thread.relation}) "${thread.title}": ${thread.state}${output}`;
          })
          .join("\n");
  return {
    system: SYSTEM_PROMPT,
    user: `Thread title: ${input.title}\n\nRelated threads:\n${related}\n\nThe thread, oldest first:\n\n${input.transcript}\n\n---\n${QUESTION} Reply with the JSON object only.`,
  };
}

const verdictSchema = z.object({
  resolved: z.boolean(),
  reason: z.string().trim().min(1).max(400),
});

/** The model's JSON verdict, taken from the last JSON object in its reply. */
export function parseVerdict(reply: string): Verdict {
  const cleaned = reply.replace(/<think>[\s\S]*?<\/think>/g, "");
  const candidates = cleaned.match(/\{[^{}]*\}/g) ?? [];
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = verdictSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  throw new Error(`The model's reply has no verdict: ${cleaned.slice(0, 200)}`);
}

const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
});

/** The model endpoint refused the call; `status` is its HTTP status. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** One OpenAI-compatible chat completion against OpenCode (Go or Zen). */
export async function askModel(
  config: ModelConfig,
  prompt: { system: string; user: string },
  sessionId: string,
  signal: AbortSignal,
): Promise<Verdict> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      // OpenCode Go refuses requests without a session id.
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 8_000,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(body);
    throw new ModelError(
      `${config.model} answered ${response.status}: ${message.success ? message.data.error.message : JSON.stringify(body)?.slice(0, 300)}`,
      response.status,
    );
  }
  const content = completionSchema.parse(body).choices[0]?.message.content;
  if (!content) throw new Error(`${config.model} returned an empty reply`);
  return parseVerdict(content);
}
