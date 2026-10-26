import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { useRightPanelStore } from "../rightPanelStore";
import { useEnvironmentScope } from "../state/session";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  codySideChats,
  useDeleteSideChats,
  useOpenSideChat,
  useRenameSideChat,
  useSideChatsSupported,
} from "./sideChats";

const CLOSED_SIDE_CHAT_PREVIEW = 5;

/** A thread's side chats in its details panel, open ones first. */
export function SideChatsDetailsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const parentRef = scopeThreadRef(props.environmentId, props.threadId);
  const supported = useSideChatsSupported(props.environmentId);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const open = useAtomValue(codySideChats.openSideChatsAtom(parentRef));
  const archived = useArchivedThreadSnapshots(supported ? [props.environmentId] : []);
  const openSideChat = useOpenSideChat();
  const renameSideChat = useRenameSideChat();
  const deleteSideChats = useDeleteSideChats();
  const [showAllClosed, setShowAllClosed] = useState(false);
  const [renaming, setRenaming] = useState<ThreadId | null>(null);
  // A menu returns focus to its trigger on close, which would end the rename it started.
  const renamePicked = useRef(false);
  const keepFocus = () => {
    const picked = renamePicked.current;
    renamePicked.current = false;
    return !picked;
  };
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

  const show = (thread: OrchestrationV2ThreadShell, isOpen: boolean) =>
    isOpen
      ? useRightPanelStore.getState().openSideChat(parentRef, thread.id)
      : void openSideChat(parentRef, { reopen: thread.id });

  const row = (thread: OrchestrationV2ThreadShell, isOpen: boolean) => (
    <li key={thread.id} className="flex items-center gap-0.5">
      {renaming === thread.id ? (
        <input
          aria-label="Side chat name"
          className="h-6 min-w-0 flex-1 rounded-sm bg-background px-2 text-xs outline-none ring-1 ring-inset ring-ring"
          defaultValue={thread.title}
          ref={(element) => {
            element?.focus();
            element?.select();
          }}
          onBlur={(event) => {
            setRenaming(null);
            void renameSideChat(
              scopeThreadRef(props.environmentId, thread.id),
              event.currentTarget.value,
            );
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = thread.title;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <Button
          variant="ghost"
          size="xs"
          className="min-w-0 flex-1 justify-between"
          onClick={() => show(thread, isOpen)}
        >
          <span className="min-w-0 truncate">{thread.title}</span>
          <span className="shrink-0 text-muted-foreground">
            {formatRelativeTimeLabel(DateTime.formatIso(thread.updatedAt))} ·{" "}
            {isOpen ? "Open" : "Closed"}
          </span>
        </Button>
      )}
      <Menu>
        <MenuTrigger
          render={
            <ThreadDetailsControl
              size="icon-xs"
              variant="ghost"
              part="icon"
              aria-label={`Actions for ${thread.title}`}
            />
          }
        >
          <MoreHorizontalIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" finalFocus={keepFocus}>
          <MenuItem onClick={() => show(thread, isOpen)}>{isOpen ? "Show" : "Reopen"}</MenuItem>
          <MenuItem
            disabled={!canOperate}
            onClick={() => {
              renamePicked.current = true;
              setRenaming(thread.id);
            }}
          >
            <PencilIcon className="size-3.5" />
            Rename
          </MenuItem>
          <MenuItem
            variant="destructive"
            disabled={!canOperate}
            onClick={() => void deleteSideChats(parentRef, [thread])}
          >
            <Trash2Icon className="size-3.5" />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );

  return (
    <ThreadDetailsSection
      headingId="thread-details-side-chats-heading"
      title="Side chats"
      actions={
        <Menu>
          <MenuTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="More side chat actions"
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              variant="destructive"
              disabled={!canOperate}
              onClick={() => void deleteSideChats(parentRef, [...open, ...closed])}
            >
              <Trash2Icon className="size-3.5" />
              Delete all side chats
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
    >
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
