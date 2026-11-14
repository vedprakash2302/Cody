import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  GitForkIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../components/ui/menu";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { newThreadId } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { shortcutLabelForCommand } from "../keybindings";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  waitForThreadShell,
} from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { orderSideChats, sideChatWorking } from "./sideChats";
import { useStartSideChat } from "./useStartSideChat";

function reportFailure(
  title: string,
  result: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
) {
  if (isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    ...(error instanceof Error ? { description: error.message } : {}),
  });
}

/**
 * The side chat header's title. Its menu switches to the main thread's other
 * side chats, starts a new one, renames this one, or continues it as a thread.
 */
export function CodySideChatTitle(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly canOperate: boolean;
}) {
  const { parentRef, threadId, canOperate } = props;
  const sideChatRef = scopeThreadRef(parentRef.environmentId, threadId);
  const shell = useQuietThreadShell(sideChatRef);
  const projection = useQuietThreadProjection(sideChatRef)?.projection ?? null;
  const sideChats = orderSideChats(useAtomValue(environmentThreadShells.sideChatsAtom(parentRef)));
  const start = useStartSideChat(canOperate ? parentRef : null);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const navigate = useNavigate();
  const newSideChatShortcut = useNewSideChatShortcut();
  const [renaming, setRenaming] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const title = shell?.title ?? "Side chat";
  const latestFinishedRun =
    projection?.runs
      .filter((run) => run.status === "completed")
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .at(-1) ?? null;

  const rename = async (next: string) => {
    setRenaming(false);
    const trimmed = next.trim();
    if (shell === null || trimmed.length === 0 || trimmed === shell.title) return;
    const result = await updateMetadata({
      environmentId: sideChatRef.environmentId,
      input: { threadId: sideChatRef.threadId, title: trimmed },
    });
    if (result._tag === "Failure") reportFailure("Could not rename the side chat", result);
  };

  // A normal fork of the side chat: a thread that can change files, with the side chat's context.
  const continueAsThread = async () => {
    if (latestFinishedRun === null || continuing) return;
    setContinuing(true);
    const targetRef = scopeThreadRef(parentRef.environmentId, newThreadId());
    const result = await forkFromRun({
      environmentId: parentRef.environmentId,
      input: {
        sourceThreadId: threadId,
        targetThreadId: targetRef.threadId,
        runId: latestFinishedRun.id,
        title,
      },
    });
    if (result._tag === "Failure") {
      setContinuing(false);
      reportFailure("Could not continue the side chat as a thread", result);
      return;
    }
    const ready = await waitForThreadShell(targetRef);
    setContinuing(false);
    if (!ready) {
      toastManager.add({
        type: "error",
        title: "The thread was created, but it did not reach this client.",
        description: "Reconnect and open it from the sidebar.",
      });
      return;
    }
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(targetRef) });
  };

  if (renaming) {
    return (
      <Input
        aria-label="Side chat name"
        size="sm"
        className="w-48"
        defaultValue={title}
        ref={(element) => {
          element?.focus();
          element?.select();
        }}
        onBlur={(event) => void rename(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void rename(event.currentTarget.value);
          if (event.key === "Escape") setRenaming(false);
        }}
      />
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="max-w-full min-w-0"
            aria-label="Side chats"
          />
        }
      >
        <span className="truncate font-medium">{title}</span>
        <ChevronDownIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        {sideChats.map((sideChat) => (
          <MenuItem
            key={sideChat.id}
            onClick={() => useRightPanelStore.getState().openSideChat(parentRef, sideChat.id)}
          >
            <MessagesSquareIcon aria-hidden="true" />
            <MenuItemLabel className="flex-1">{sideChat.title}</MenuItemLabel>
            <SideChatWorkingIndicator
              sideChatRef={scopeThreadRef(parentRef.environmentId, sideChat.id)}
            />
            {sideChat.id === threadId ? <CheckIcon aria-hidden="true" /> : null}
          </MenuItem>
        ))}
        <MenuItem disabled={!start.available} onClick={() => void start.open()}>
          <PlusIcon aria-hidden="true" />
          <MenuItemLabel className="flex-1">New side chat</MenuItemLabel>
          {newSideChatShortcut ? <MenuShortcut>{newSideChatShortcut}</MenuShortcut> : null}
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={!canOperate || shell === null} onClick={() => setRenaming(true)}>
          <PencilIcon aria-hidden="true" />
          <MenuItemLabel>Rename</MenuItemLabel>
        </MenuItem>
        <MenuItem
          disabled={!canOperate || latestFinishedRun === null || continuing}
          onClick={() => void continueAsThread()}
        >
          <GitForkIcon aria-hidden="true" />
          <MenuItemLabel>Continue as thread</MenuItemLabel>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Starts another side chat of the main thread, from the side chat header. */
export function CodyNewSideChatButton(props: {
  readonly parentRef: ScopedThreadRef;
  readonly canOperate: boolean;
}) {
  const start = useStartSideChat(props.canOperate ? props.parentRef : null);
  const shortcut = useNewSideChatShortcut();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New side chat"
            disabled={!start.available}
            onClick={() => void start.open()}
          />
        }
      >
        <PlusIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {shortcut ? `New side chat (${shortcut})` : "New side chat"}
      </TooltipPopup>
    </Tooltip>
  );
}

function useNewSideChatShortcut(): string | null {
  return shortcutLabelForCommand(useAtomValue(primaryServerKeybindingsAtom), "thread.sideChat");
}

/**
 * A spinner while the side chat's reply is on its way. The side chat list keeps
 * its entries through run changes, so each reads its own shell.
 */
export function SideChatWorkingIndicator(props: { readonly sideChatRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(props.sideChatRef);
  return shell !== null && sideChatWorking(shell) ? (
    <Spinner aria-hidden="true" size="sm" tone="muted" />
  ) : null;
}
