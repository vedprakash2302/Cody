import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Group, GroupSeparator } from "../components/ui/group";
import {
  Menu,
  MenuItem,
  MenuItemDetail,
  MenuItemLabel,
  MenuPopup,
  MenuTrigger,
} from "../components/ui/menu";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { newMessageId } from "../lib/utils";
import { useQuietThreadProjection, useQuietThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { CodyNewSideChatButton } from "./CodySideChatTitle";
import { cancelSummary, useSummarizing, watchSummary } from "./sideChatSummaries";
import {
  addCatchUp,
  bringBackSideChat,
  bringBackSize,
  formatTokens,
  SUMMARY_PROMPT,
  sideChatWorking,
  useSideChatCatchUp,
} from "./sideChats";

/** Cody hides upstream's Bring back: this bar's works while the main thread runs. */
export const CODY_SIDE_CHAT_BAR: boolean = true;

/**
 * Cody's actions in a side chat's header: catch up with main, bring the side
 * chat back into main's next message whole or as a summary, and start another.
 */
export function CodySideChatBar(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly canOperate: boolean;
}) {
  const { parentRef, canOperate } = props;
  const sideChatRef = scopeThreadRef(parentRef.environmentId, props.threadId);
  const shell = useQuietThreadShell(sideChatRef);
  const sideChat = useQuietThreadProjection(sideChatRef)?.projection ?? null;
  const main = useQuietThreadProjection(parentRef)?.projection ?? null;
  const { newReplies, wentBack } = useSideChatCatchUp(sideChatRef, parentRef);
  const size = bringBackSize(sideChat, main, props.threadId);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const summarizing = useSummarizing(sideChatRef);

  if (shell === null) return null;
  const hasReply = shell.latestRun !== null && shell.latestRun.status !== "queued";
  const sideChatBusy = sideChatWorking(shell);
  const bringBackBlocked = !canOperate
    ? "This connection cannot change threads."
    : !hasReply
      ? "Available after a reply."
      : null;

  const requestSummary = async () => {
    if (bringBackBlocked !== null || sideChatBusy || summarizing) return;
    const messageId = newMessageId();
    watchSummary({ sideChatRef, parentRef, messageId });
    const result = await startTurn({
      environmentId: sideChatRef.environmentId,
      input: {
        threadId: sideChatRef.threadId,
        message: { messageId, role: "user", text: SUMMARY_PROMPT, attachments: [] },
        runtimeMode: shell.runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      },
    });
    if (result._tag === "Failure") {
      cancelSummary(sideChatRef);
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not ask the side chat for a summary",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  return (
    <>
      {newReplies > 0 || wentBack ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                disabled={!canOperate}
                onClick={() => addCatchUp(sideChatRef, parentRef)}
              >
                {newReplies > 0 ? `${newReplies} new in main` : "Main went back"}
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            Adds what the main thread did since this side chat last saw it to your next message
            here.
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Group aria-label="Bring back">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={bringBackBlocked !== null || undefined}
                onClick={() => {
                  if (bringBackBlocked === null) bringBackSideChat(sideChatRef, parentRef);
                }}
              >
                Bring back
                {size.newReplies > 0 ? (
                  <span className="text-muted-foreground">{formatTokens(size.tokens)}</span>
                ) : null}
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            {bringBackBlocked ??
              (size.newReplies > 0
                ? `Adds the ${size.newReplies === 1 ? "reply" : `${size.newReplies} replies`} main hasn't seen (${formatTokens(size.tokens)} tokens) to the main thread's next message. Works while the main thread runs.`
                : "Main has everything this side chat said. Bringing it back again adds nothing new.")}
          </TooltipPopup>
        </Tooltip>
        <GroupSeparator />
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="More ways to bring back"
                disabled={bringBackBlocked !== null}
              />
            }
          >
            {summarizing ? <Spinner size="sm" aria-label="Summarizing" /> : <ChevronDownIcon />}
          </MenuTrigger>
          <MenuPopup align="end" className="w-72">
            <MenuItem onClick={() => bringBackSideChat(sideChatRef, parentRef)}>
              <MenuItemLabel className="flex-1">Everything new</MenuItemLabel>
              {size.newReplies > 0 ? (
                <MenuItemDetail>{formatTokens(size.tokens)} tokens</MenuItemDetail>
              ) : null}
            </MenuItem>
            <MenuItem disabled={sideChatBusy || summarizing} onClick={() => void requestSummary()}>
              <MenuItemLabel className="flex-1">
                {summarizing ? "Summarizing…" : "Summary"}
              </MenuItemLabel>
              <MenuItemDetail>
                {sideChatBusy && !summarizing ? "when idle" : "costs a turn"}
              </MenuItemDetail>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </Group>
      <CodyNewSideChatButton parentRef={parentRef} canOperate={canOperate} />
    </>
  );
}
