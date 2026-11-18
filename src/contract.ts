import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const resolvedThreadSchema = z.object({
  threadId: z.string(),
  /** The probability, from 0 to 1, that the thread's work is resolved. */
  confidence: z.number(),
  checkedAt: z.number(),
});
export type ResolvedThread = z.infer<typeof resolvedThreadSchema>;

export const rpcContract = defineRpcContract({
  resolved_list: {
    input: z.null(),
    output: z.object({
      threads: z.array(resolvedThreadSchema),
      /** Idle threads awaiting a fresh verdict: settling after a turn, or with a model call in flight. */
      judging: z.array(z.string()),
    }),
  },
});
