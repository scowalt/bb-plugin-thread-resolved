// Thread Resolved: a checkmark on threads the server judged resolved, in the
// sidebar row and beside the thread's composer. Unresolved threads show nothing.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useRealtime,
  useRpc,
  type ExperimentalThreadContextSegmentProps,
  type PluginContentScriptContext,
} from "@get-bb/plugin-sdk/app";
// Types only: git installs build without dev dependencies, so the frontend
// bundle cannot import the SDK root (or zod) through the contract module.
import { VERDICTS_CHANGED } from "./src/channels";
import type { ResolvedThread, rpcContract } from "./src/contract";

/** Resolved threads by id, refetched whenever the server's verdicts change. */
function useResolvedThreads(): ReadonlyMap<string, ResolvedThread> {
  const rpc = useRpc<typeof rpcContract>();
  const [threads, setThreads] = useState<readonly ResolvedThread[]>([]);
  const refetch = useCallback(() => {
    rpc.call("resolved_list").then(
      (result) => setThreads(result.threads),
      () => {},
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(VERDICTS_CHANGED, refetch);
  return useMemo(() => new Map(threads.map((thread) => [thread.threadId, thread])), [threads]);
}

// Only a content script may set sidebar row statuses, and only a React slot
// may read RPC, so the script hands its setter to the overlay below.
type SetRowStatus = NonNullable<PluginContentScriptContext["experimental_setThreadRowStatus"]>;
let setRowStatus: SetRowStatus | null = null;
const setterListeners = new Set<() => void>();

function useRowStatusSetter(): SetRowStatus | null {
  const [setter, setSetter] = useState(() => setRowStatus);
  useEffect(() => {
    const update = () => setSetter(() => setRowStatus);
    setterListeners.add(update);
    update();
    return () => void setterListeners.delete(update);
  }, []);
  return setter;
}

function SidebarCheckmarks() {
  const resolved = useResolvedThreads();
  const setter = useRowStatusSetter();
  useEffect(() => {
    if (!setter) return;
    for (const [threadId, thread] of resolved) {
      setter(threadId, { icon: "CircleCheck", label: `Resolved: ${thread.reason}`, tone: "success" });
    }
    return () => {
      for (const threadId of resolved.keys()) setter(threadId, null);
    };
  }, [resolved, setter]);
  return null;
}

function ResolvedChip({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const thread = useResolvedThreads().get(threadId);
  if (!thread) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      title={thread.reason}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-success hover:bg-state-hover"
    >
      <Icon name="CircleCheck" className="size-3.5" />
      Resolved
    </button>
  );
}

function ResolvedDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const thread = useResolvedThreads().get(threadId);
  if (!isExpanded || !thread) return null;
  return (
    <p className="px-1.5 pt-1 pb-1 text-xs text-muted-foreground">
      {thread.reason}{" "}
      <span className="opacity-70">· checked {new Date(thread.checkedAt).toLocaleTimeString()}</span>
    </p>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "row-status-bridge",
    mount({ experimental_setThreadRowStatus }) {
      setRowStatus = experimental_setThreadRowStatus ?? null;
      for (const listener of setterListeners) listener();
      return () => {
        setRowStatus = null;
        for (const listener of setterListeners) listener();
      };
    },
  });
  app.slots.experimental_appOverlay({ id: "sidebar-checkmarks", component: SidebarCheckmarks });
  app.slots.experimental_threadContextSegment({
    id: "resolved",
    title: "Thread resolved",
    group: "1_thread",
    order: 100,
    summary: ResolvedChip,
    details: ResolvedDetails,
    useVisible: ({ threadId }) => useResolvedThreads().has(threadId),
  });
});
