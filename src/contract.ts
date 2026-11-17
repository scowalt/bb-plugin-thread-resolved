import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const resolvedThreadSchema = z.object({
  threadId: z.string(),
  reason: z.string(),
  checkedAt: z.number(),
});
export type ResolvedThread = z.infer<typeof resolvedThreadSchema>;

export const rpcContract = defineRpcContract({
  resolved_list: {
    input: z.null(),
    output: z.object({ threads: z.array(resolvedThreadSchema) }),
  },
});
