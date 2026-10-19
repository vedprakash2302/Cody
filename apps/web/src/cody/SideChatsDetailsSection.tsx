import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { useRightPanelStore } from "../rightPanelStore";
import { waitForThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { codySideChats, useSideChatsSupported } from "./sideChats";

const CLOSED_SIDE_CHAT_LIMIT = 5;

const sideChatLabel = (thread: OrchestrationV2ThreadShell) => {
  const message = thread.latestVisibleMessage;
  return message !== null && DateTime.isGreaterThanOrEqualTo(message.updatedAt, thread.createdAt)
    ? message.text
    : "No messages yet";
};

/**
 * A thread's side chats in its details panel. Open ones show in the right
 * panel; closed ones are unarchived first.
 */
export function SideChatsDetailsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const parentRef = scopeThreadRef(props.environmentId, props.threadId);
  const supported = useSideChatsSupported(props.environmentId);
  const open = useAtomValue(codySideChats.openSideChatsAtom(parentRef));
  const archived = useArchivedThreadSnapshots(supported ? [props.environmentId] : []);
  const unarchive = useOrchestrationCommand(threadEnvironment.unarchive, { reportFailure: false });
  const closed = (
    archived.snapshots.find((entry) => entry.environmentId === props.environmentId)?.snapshot
      .threads ?? []
  )
    .filter(
      (thread) => thread.codySideChat === true && thread.lineage.parentThreadId === props.threadId,
    )
    .sort((left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds)
    .slice(0, CLOSED_SIDE_CHAT_LIMIT);

  if (!supported || (open.length === 0 && closed.length === 0)) return null;

  const show = (sideChatThreadId: ThreadId) =>
    useRightPanelStore.getState().openSideChat(parentRef, sideChatThreadId);

  const reopen = async (sideChatThreadId: ThreadId) => {
    const result = await unarchive({
      environmentId: props.environmentId,
      input: { threadId: sideChatThreadId },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Couldn't reopen the side chat",
          description: error instanceof Error ? error.message : "Try again in a moment.",
        });
      }
      return;
    }
    archived.refresh();
    if (await waitForThreadShell(scopeThreadRef(props.environmentId, sideChatThreadId))) {
      show(sideChatThreadId);
    }
  };

  const row = (thread: OrchestrationV2ThreadShell, isOpen: boolean) => (
    <li key={thread.id}>
      <Button
        variant="ghost"
        size="xs"
        className="w-full justify-between"
        onClick={() => void (isOpen ? show(thread.id) : reopen(thread.id))}
      >
        <span className="min-w-0 truncate">{sideChatLabel(thread)}</span>
        <span className="shrink-0 text-muted-foreground">
          {isOpen ? "Open" : formatRelativeTimeLabel(DateTime.formatIso(thread.updatedAt))}
        </span>
      </Button>
    </li>
  );

  return (
    <ThreadDetailsSection headingId="thread-details-side-chats-heading" title="Side chats">
      <ul className="flex flex-col">
        {open.map((thread) => row(thread, true))}
        {closed.map((thread) => row(thread, false))}
      </ul>
    </ThreadDetailsSection>
  );
}
