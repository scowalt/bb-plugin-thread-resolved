// Thread Resolved: a checkmark on threads the server judged resolved, in the
// sidebar row and beside the thread's composer, and a spinner while a
// verdict is on its way. Unresolved threads show nothing.
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

type Verdict = { kind: "resolved"; thread: ResolvedThread } | { kind: "judging" };

/**
 * Each thread's verdict by id, refetched whenever the server's verdicts
 * change. A thread being re-judged shows as judging even if its old verdict
 * was resolved, since a new turn already cleared that.
 */
function useVerdicts(): ReadonlyMap<string, Verdict> {
  const rpc = useRpc<typeof rpcContract>();
  const [list, setList] = useState<{ threads: readonly ResolvedThread[]; judging: readonly string[] }>({
    threads: [],
    judging: [],
  });
  const refetch = useCallback(() => {
    rpc.call("resolved_list").then(setList, () => {});
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(VERDICTS_CHANGED, refetch);
  return useMemo(() => {
    const verdicts = new Map<string, Verdict>(list.threads.map((thread) => [thread.threadId, { kind: "resolved", thread }]));
    for (const threadId of list.judging) verdicts.set(threadId, { kind: "judging" });
    return verdicts;
  }, [list]);
}

const JUDGING_LABEL = "Checking whether this thread is resolved";
const percent = (confidence: number) => `${Math.round(confidence * 100)}%`;

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
  const verdicts = useVerdicts();
  const setter = useRowStatusSetter();
  useEffect(() => {
    if (!setter) return;
    for (const [threadId, verdict] of verdicts) {
      setter(
        threadId,
        verdict.kind === "resolved"
          ? { icon: "CircleCheck", label: `Resolved (${percent(verdict.thread.confidence)} confident)`, tone: "success" }
          : { icon: "Loading", label: JUDGING_LABEL },
      );
    }
    return () => {
      for (const threadId of verdicts.keys()) setter(threadId, null);
    };
  }, [verdicts, setter]);
  return null;
}

function ResolvedChip({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const verdict = useVerdicts().get(threadId);
  if (!verdict) return null;
  if (verdict.kind === "judging") {
    return (
      <span
        title={JUDGING_LABEL}
        className="inline-flex h-6 shrink-0 items-center gap-1 px-1.5 text-xs text-muted-foreground"
      >
        <Icon name="Loading" className="size-3.5 animate-spin" />
        Checking…
      </span>
    );
  }
  const { thread } = verdict;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      title={`${percent(thread.confidence)} confident`}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-success hover:bg-state-hover"
    >
      <Icon name="CircleCheck" className="size-3.5" />
      Resolved
      <span className="opacity-70">{percent(thread.confidence)}</span>
    </button>
  );
}

function ResolvedDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const verdict = useVerdicts().get(threadId);
  if (!isExpanded || verdict?.kind !== "resolved") return null;
  const { thread } = verdict;
  return (
    <p className="px-1.5 pt-1 pb-1 text-xs text-muted-foreground">
      {percent(thread.confidence)} confident{" "}
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
    useVisible: ({ threadId }) => useVerdicts().has(threadId),
  });
});
