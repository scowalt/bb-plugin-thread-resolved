import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadVerdictSchema = z.object({
  threadId: z.string(),
  /** Whether `confidence` reaches the threshold setting. */
  resolved: z.boolean(),
  /** The probability, from 0 to 1, that the thread's work is resolved. */
  confidence: z.number(),
  /** How much of the work, from 0 to 1, the model thinks is finished. */
  progress: z.number(),
  checkedAt: z.number(),
});
export type ThreadVerdict = z.infer<typeof threadVerdictSchema>;

export const rpcContract = defineRpcContract({
  verdict_list: {
    input: z.null(),
    output: z.object({
      /** Every idle thread with a current verdict, resolved or not. */
      threads: z.array(threadVerdictSchema),
      /** Idle threads awaiting a fresh verdict: settling after a turn, or with a model call in flight. */
      judging: z.array(z.string()),
    }),
  },
});
