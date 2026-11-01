import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useQuietThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { addCatchUp, bringBackSideChat, useSideChatCatchUp } from "./sideChats";

/** Cody hides upstream's Bring back: this bar's works while the main thread runs. */
export const CODY_SIDE_CHAT_BAR: boolean = true;

/**
 * Cody's actions in a side chat's header: catch up with main, bring the side
 * chat back into main's next message, and rename it.
 */
export function CodySideChatBar(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly canOperate: boolean;
}) {
  const { parentRef, canOperate } = props;
  const sideChatRef = scopeThreadRef(parentRef.environmentId, props.threadId);
  const shell = useQuietThreadShell(sideChatRef);
  const { newReplies, wentBack } = useSideChatCatchUp(sideChatRef, parentRef);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState(false);
  if (shell === null) return null;
  const hasReply = shell.latestRun !== null && shell.latestRun.status !== "queued";

  const rename = async (title: string) => {
    setRenaming(false);
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed === shell.title) return;
    const result = await updateMetadata({
      environmentId: sideChatRef.environmentId,
      input: { threadId: sideChatRef.threadId, title: trimmed },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not rename the side chat",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  if (renaming) {
    return (
      <Input
        aria-label="Side chat name"
        size="sm"
        className="w-40"
        defaultValue={shell.title}
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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              aria-disabled={!canOperate || !hasReply || undefined}
              onClick={() => {
                if (canOperate && hasReply) bringBackSideChat(sideChatRef, parentRef);
              }}
            >
              Bring back
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          {!canOperate
            ? "This connection cannot change threads."
            : !hasReply
              ? "Available after a reply."
              : "Adds what this side chat said since you last brought it back to the main thread's next message. Works while the main thread runs."}
        </TooltipPopup>
      </Tooltip>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Rename side chat"
        disabled={!canOperate}
        onClick={() => setRenaming(true)}
      >
        <PencilIcon />
      </Button>
    </>
  );
}
