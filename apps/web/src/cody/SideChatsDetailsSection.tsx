import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { MessagesSquareIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react";
import { useState, type MouseEvent } from "react";

import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { ThreadRelationshipIcon } from "../components/chat/ThreadRelationshipIcon";
import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { readLocalApi } from "../localApi";
import { useRightPanelStore } from "../rightPanelStore";
import { useThreadShell } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  codySideChats,
  useDeleteSideChats,
  useOpenSideChat,
  useRenameSideChat,
  useSideChatsSupported,
} from "./sideChats";

/** An open side chat's state, as Lineage shows a related thread's. */
function useOpenSideChatStatus(ref: ScopedThreadRef) {
  const shell = useThreadShell(ref);
  if (shell === null) return { status: null, label: null };
  switch (resolveSidebarThreadStatus(shell)) {
    case "approval":
    case "input":
      return { status: "waiting", label: "Needs you" };
    case "working":
      return { status: "running", label: "Working" };
    case "failed":
    case "limited":
      return { status: "failed", label: "Failed" };
    default:
      return { status: null, label: null };
  }
}

function SideChatRow(props: {
  readonly sideChatRef: ScopedThreadRef;
  readonly thread: OrchestrationV2ThreadShell;
  readonly isOpen: boolean;
  readonly canOperate: boolean;
  readonly onShow: () => void;
  readonly onDelete: () => void;
}) {
  const renameSideChat = useRenameSideChat();
  const [renaming, setRenaming] = useState(false);
  const live = useOpenSideChatStatus(props.sideChatRef);
  const { status, label } = props.isOpen
    ? live
    : {
        status: null,
        label: formatRelativeTimeLabel(DateTime.formatIso(props.thread.updatedAt)),
      };

  const showMenu = async (event: MouseEvent) => {
    if (!props.canOperate) return;
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    const action = await api.contextMenu.show(
      [
        { id: "rename" as const, label: "Rename" },
        { id: "delete" as const, label: "Delete", destructive: true },
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (action === "rename") setRenaming(true);
    if (action === "delete") props.onDelete();
  };

  if (renaming) {
    return (
      <li className="flex h-8 items-center px-1">
        <input
          aria-label="Side chat name"
          className="h-7 min-w-0 flex-1 rounded-md bg-background px-2 text-sm outline-none ring-1 ring-inset ring-ring"
          defaultValue={props.thread.title}
          ref={(element) => {
            element?.focus();
            element?.select();
          }}
          onBlur={(event) => {
            setRenaming(false);
            void renameSideChat(props.sideChatRef, event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = props.thread.title;
              event.currentTarget.blur();
            }
          }}
        />
      </li>
    );
  }

  return (
    <li className="group relative flex h-8 items-center rounded-lg" onContextMenu={showMenu}>
      <ThreadDetailsControl
        size="sm"
        variant="ghost"
        part="row"
        aria-label={
          props.isOpen
            ? `Show ${props.thread.title}${label === null ? "" : `, ${label}`}`
            : `Reopen ${props.thread.title}`
        }
        onClick={props.onShow}
      >
        <ThreadRelationshipIcon fallbackIcon={MessagesSquareIcon} status={status} />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-left text-sm font-medium leading-4 ${props.isOpen ? "text-foreground/85" : "text-muted-foreground"}`}
          >
            {props.thread.title}
          </span>
        </span>
        {label === null ? null : (
          <span
            className={`shrink-0 text-2xs text-muted-foreground ${props.canOperate ? "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0" : ""}`}
          >
            {label}
          </span>
        )}
      </ThreadDetailsControl>
      {props.canOperate ? (
        <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  tone="destructive"
                  aria-label={`Delete ${props.thread.title}`}
                  onClick={props.onDelete}
                />
              }
            >
              <Trash2Icon aria-hidden className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="left">Delete side chat</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </li>
  );
}

/** A thread's side chats in its details panel: open ones, then closed ones folded away. */
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
  const deleteSideChats = useDeleteSideChats();
  const [showClosed, setShowClosed] = useState(false);
  const closed = (
    archived.snapshots.find((entry) => entry.environmentId === props.environmentId)?.snapshot
      .threads ?? []
  )
    .filter(
      (thread) => thread.codySideChat === true && thread.lineage.parentThreadId === props.threadId,
    )
    .sort((left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds);

  if (!supported || (open.length === 0 && closed.length === 0)) return null;

  const row = (thread: OrchestrationV2ThreadShell, isOpen: boolean) => (
    <SideChatRow
      key={thread.id}
      sideChatRef={scopeThreadRef(props.environmentId, thread.id)}
      thread={thread}
      isOpen={isOpen}
      canOperate={canOperate}
      onShow={() =>
        isOpen
          ? useRightPanelStore.getState().openSideChat(parentRef, thread.id)
          : void openSideChat(parentRef, { reopen: thread.id })
      }
      onDelete={() => void deleteSideChats(parentRef, [thread])}
    />
  );

  return (
    <ThreadDetailsSection
      headingId="thread-details-side-chats-heading"
      title="Side chats"
      actions={
        canOperate ? (
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
                onClick={() => void deleteSideChats(parentRef, [...open, ...closed])}
              >
                <Trash2Icon className="size-3.5" />
                Delete all side chats
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null
      }
    >
      {open.length === 0 ? null : (
        <ul className="m-0 list-none p-0">{open.map((thread) => row(thread, true))}</ul>
      )}
      {closed.length === 0 ? null : (
        <div>
          <CollapsibleSectionHeader
            variant="panel"
            expanded={showClosed}
            onClick={() => setShowClosed(!showClosed)}
          >
            Closed{showClosed ? "" : ` (${closed.length})`}
          </CollapsibleSectionHeader>
          {showClosed ? (
            <ul className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0">
              {closed.map((thread) => row(thread, false))}
            </ul>
          ) : null}
        </div>
      )}
    </ThreadDetailsSection>
  );
}
