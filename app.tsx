// Thread Resolved: a checkmark on threads the server judged resolved, in the
// sidebar row and beside the thread's composer, how much of the work is done
// on the rest, and a spinner while a verdict is on its way.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useRealtime,
  useRpc,
  type ExperimentalThreadContextSegmentProps,
  type ExperimentalThreadRowMetadataProps,
  type PluginContentScriptContext,
} from "@get-bb/plugin-sdk/app";
// Types only: git installs build without dev dependencies, so the frontend
// bundle cannot import the SDK root (or zod) through the contract module.
import { VERDICTS_CHANGED } from "./src/channels";
import type { rpcContract, ThreadVerdict } from "./src/contract";

type Verdict = { kind: "judged"; thread: ThreadVerdict } | { kind: "judging" };
type Verdicts = ReadonlyMap<string, Verdict>;

/**
 * Each thread's verdict by id, refetched whenever the server's verdicts
 * change. A thread being re-judged shows as judging even if it has an old
 * verdict, since a new turn already cleared that.
 */
function useVerdicts(): Verdicts {
  const rpc = useRpc<typeof rpcContract>();
  const [list, setList] = useState<{ threads: readonly ThreadVerdict[]; judging: readonly string[] }>({
    threads: [],
    judging: [],
  });
  const refetch = useCallback(() => {
    rpc.call("verdict_list").then(setList, () => {});
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(VERDICTS_CHANGED, refetch);
  return useMemo(() => {
    const verdicts = new Map<string, Verdict>(list.threads.map((thread) => [thread.threadId, { kind: "judged", thread }]));
    for (const threadId of list.judging) verdicts.set(threadId, { kind: "judging" });
    return verdicts;
  }, [list]);
}

const JUDGING_LABEL = "Checking whether this thread is resolved";
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const doneLabel = (thread: ThreadVerdict) => `About ${percent(thread.progress)} done`;

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

/** Resolved and judging threads get a row icon; open ones keep bb's own glyph. */
function SidebarCheckmarks() {
  const verdicts = useVerdicts();
  const setter = useRowStatusSetter();
  useEffect(() => {
    if (!setter) return;
    const marked: string[] = [];
    for (const [threadId, verdict] of verdicts) {
      if (verdict.kind === "judged" && !verdict.thread.resolved) continue;
      marked.push(threadId);
      setter(
        threadId,
        verdict.kind === "judged"
          ? { icon: "CircleCheck", label: `Resolved (${percent(verdict.thread.confidence)} confident)`, tone: "success" }
          : { icon: "Loading", label: JUDGING_LABEL },
      );
    }
    return () => {
      for (const threadId of marked) setter(threadId, null);
    };
  }, [verdicts, setter]);
  return null;
}

/** "45%" on the sidebar row's metadata line of a thread that is not resolved. */
function ProgressMetadata({ thread, data }: ExperimentalThreadRowMetadataProps<Verdicts>) {
  const verdict = data.get(thread.id);
  if (verdict?.kind !== "judged" || verdict.thread.resolved) return null;
  return (
    <span title={doneLabel(verdict.thread)} className="text-xs text-muted-foreground tabular-nums">
      {percent(verdict.thread.progress)}
    </span>
  );
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
      title={thread.resolved ? `${percent(thread.confidence)} confident` : doneLabel(thread)}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-state-hover ${
        thread.resolved ? "text-success" : "text-muted-foreground"
      }`}
    >
      {thread.resolved ? (
        <>
          <Icon name="CircleCheck" className="size-3.5" />
          Resolved
          <span className="opacity-70">{percent(thread.confidence)}</span>
        </>
      ) : (
        `${percent(thread.progress)} done`
      )}
    </button>
  );
}

function ResolvedDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const verdict = useVerdicts().get(threadId);
  if (!isExpanded || verdict?.kind !== "judged") return null;
  const { thread } = verdict;
  return (
    <p className="px-1.5 pt-1 pb-1 text-xs text-muted-foreground">
      {doneLabel(thread)} · {percent(thread.confidence)} confident it is resolved{" "}
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
  app.slots.experimental_threadRowMetadata<Verdicts>({
    id: "progress",
    useData: useVerdicts,
    component: ProgressMetadata,
  });
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
