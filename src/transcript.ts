import { z } from "zod";

/** The two event types a transcript is built from; everything else is streaming noise. */
export const TRANSCRIPT_EVENT_TYPES = ["client/turn/requested", "item/completed"] as const;

export interface RawEvent {
  type: string;
  seq: number;
  data: unknown;
}

const turnRequested = z.object({
  initiator: z.string().nullish(),
  senderThreadId: z.string().nullish(),
  input: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
});

const completedItem = z.object({
  item: z.discriminatedUnion("type", [
    z.object({ type: z.literal("agentMessage"), text: z.string() }),
    z.object({ type: z.literal("commandExecution"), command: z.string() }),
    z.object({
      type: z.literal("toolCall"),
      tool: z.string(),
      arguments: z.unknown(),
      result: z.unknown(),
    }),
    z.object({
      type: z.literal("fileChange"),
      changes: z.array(z.object({ path: z.string(), kind: z.string() })).default([]),
    }),
  ]),
});

const MESSAGE_CAP = 6_000;
const COMMAND_CAP = 300;
const TOOL_CAP = 300;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}… [${trimmed.length - max} chars cut]`;
}

function oneLine(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return clip(text.replace(/\s+/g, " "), max);
}

/** One readable entry per user turn, agent reply, command, tool call or file edit. */
export function eventToEntry(event: RawEvent): string | null {
  if (event.type === "client/turn/requested") {
    const parsed = turnRequested.safeParse(event.data);
    if (!parsed.success) return null;
    const text = parsed.data.input
      .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
      .join("\n");
    const who = parsed.data.senderThreadId
      ? `MESSAGE FROM @thread:${parsed.data.senderThreadId}`
      : parsed.data.initiator === "system"
        ? "BB SYSTEM MESSAGE"
        : "USER";
    return `### ${who}\n${clip(text, MESSAGE_CAP)}`;
  }
  if (event.type !== "item/completed") return null;
  const parsed = completedItem.safeParse(event.data);
  if (!parsed.success) return null;
  const item = parsed.data.item;
  switch (item.type) {
    case "agentMessage":
      return item.text.trim() === "" ? null : `### AGENT\n${clip(item.text, MESSAGE_CAP)}`;
    case "commandExecution":
      return `$ ${oneLine(item.command, COMMAND_CAP)}`;
    case "toolCall":
      return `[tool ${item.tool}] ${oneLine(item.arguments, TOOL_CAP)} => ${oneLine(item.result, TOOL_CAP)}`;
    case "fileChange":
      return item.changes.map((change) => `[${change.kind} ${change.path}]`).join("\n") || null;
  }
}

/**
 * The whole thread as text, at most `budget` characters. When it is longer, the
 * opening (the task) and the end (where the thread stands) are kept and the
 * middle is cut, since those two decide whether the work is done.
 */
export function buildTranscript(entries: readonly string[], budget: number): string {
  const full = entries.join("\n\n");
  if (full.length <= budget) return full;
  const head = Math.floor(budget * 0.25);
  const tail = budget - head;
  return `${full.slice(0, head)}\n\n[… ${full.length - budget} characters from the middle of the thread omitted …]\n\n${full.slice(-tail)}`;
}

/** Thread ids the transcript mentions, in first-seen order, without `self`. */
export function mentionedThreadIds(text: string, self: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\bthr_[a-z0-9]{6,}\b/g)) {
    if (match[0] !== self) ids.add(match[0]);
  }
  return [...ids];
}
