import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { Button } from "../components/ui/button";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { useRightPanelStore } from "../rightPanelStore";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { codySideChats, useOpenSideChat, useSideChatsSupported } from "./sideChats";

const CLOSED_SIDE_CHAT_PREVIEW = 5;

const sideChatLabel = (thread: OrchestrationV2ThreadShell) =>
  `Started ${formatRelativeTimeLabel(DateTime.formatIso(thread.createdAt))}`;

/**
 * A thread's side chats in its details panel. The open one shows in the right
 * panel; reopening a closed one closes the open one, since a thread keeps one.
 */
export function SideChatsDetailsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const parentRef = scopeThreadRef(props.environmentId, props.threadId);
  const supported = useSideChatsSupported(props.environmentId);
  const open = useAtomValue(codySideChats.openSideChatsAtom(parentRef));
  const archived = useArchivedThreadSnapshots(supported ? [props.environmentId] : []);
  const openSideChat = useOpenSideChat();
  const [showAllClosed, setShowAllClosed] = useState(false);
  const closed = (
    archived.snapshots.find((entry) => entry.environmentId === props.environmentId)?.snapshot
      .threads ?? []
  )
    .filter(
      (thread) => thread.codySideChat === true && thread.lineage.parentThreadId === props.threadId,
    )
    .sort((left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds);
  const shownClosed = showAllClosed ? closed : closed.slice(0, CLOSED_SIDE_CHAT_PREVIEW);

  if (!supported || (open.length === 0 && closed.length === 0)) return null;

  const row = (thread: OrchestrationV2ThreadShell, isOpen: boolean) => (
    <li key={thread.id}>
      <Button
        variant="ghost"
        size="xs"
        className="w-full justify-between"
        onClick={() =>
          isOpen
            ? useRightPanelStore.getState().openSideChat(parentRef, thread.id)
            : void openSideChat(parentRef, { reopen: thread.id })
        }
      >
        <span className="min-w-0 truncate">{sideChatLabel(thread)}</span>
        <span className="shrink-0 text-muted-foreground">{isOpen ? "Open" : "Closed"}</span>
      </Button>
    </li>
  );

  return (
    <ThreadDetailsSection headingId="thread-details-side-chats-heading" title="Side chats">
      <ul className="flex flex-col">
        {open.map((thread) => row(thread, true))}
        {shownClosed.map((thread) => row(thread, false))}
      </ul>
      {closed.length > shownClosed.length ? (
        <Button variant="ghost-muted" size="xs" onClick={() => setShowAllClosed(true)}>
          Show {closed.length - shownClosed.length} more
        </Button>
      ) : null}
    </ThreadDetailsSection>
  );
}
