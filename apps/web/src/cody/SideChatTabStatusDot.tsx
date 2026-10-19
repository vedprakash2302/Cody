import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../components/Sidebar.logic";
import { cn } from "../lib/utils";
import { useThreadShell } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";

/**
 * The side chat's state on its tab, in the sidebar's colors: it needs you, it
 * is working, or it answered while its tab was out of view.
 */
export function SideChatTabStatusDot(props: {
  readonly environmentId: EnvironmentId;
  readonly sideChatThreadId: string;
}) {
  const ref = scopeThreadRef(props.environmentId, ThreadId.make(props.sideChatThreadId));
  const thread = useThreadShell(ref);
  const localLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[scopedThreadKey(ref)],
  );
  if (thread === null) return null;
  const status = resolveSidebarThreadStatus(thread);
  const unread = hasUnseenCompletion({
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
  });
  const tone =
    status === "approval" || status === "input"
      ? "text-warning-foreground"
      : status === "working"
        ? "text-info"
        : status === "failed"
          ? "text-error"
          : unread
            ? "text-success"
            : null;
  if (tone === null) return null;
  return (
    <span
      className={cn("absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current", tone)}
      aria-hidden
    />
  );
}
