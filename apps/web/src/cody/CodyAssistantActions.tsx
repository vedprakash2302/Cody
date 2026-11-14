import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import { ASSISTANT_CITATION_MAX_TEXT_LENGTH, type ScopedThreadRef } from "@t3tools/contracts";
import { MessageSquareShareIcon, MessagesSquareIcon } from "lucide-react";
import { use, useState } from "react";

import { TimelineRowCtx, type TimelineRow } from "../components/chat/timelineRowContext";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  createAssistantTextSelector,
  readAssistantText,
  type AssistantCitationSourceAnchor,
} from "../lib/assistantTextSelection";
import { cn } from "../lib/utils";
import { useQuietThreadShell } from "../state/entities";
import { useV2ItemSupport } from "../state/v2ItemSupport";
import type { ChatMessage } from "../types";
import { useSideChatsOffered } from "./sideChatPalette";
import { citeInComposer, useMainComposer } from "./sideChatComposers";
import { useStartSideChat } from "./useStartSideChat";

type ProjectedItem = NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;

/**
 * Cody's actions on an assistant reply: "Send to main" in a side chat, and
 * "Side chat from here" in a thread that offers side chats.
 */
export function CodyAssistantActions(props: {
  readonly message: ChatMessage;
  readonly projectedItem: ProjectedItem | undefined;
}) {
  const { threadRef } = use(TimelineRowCtx);
  const shell = useQuietThreadShell(threadRef);
  if (threadRef === null || shell === null || props.message.streaming) return null;
  const parentThreadId = shell.lineage.sideChat === true ? shell.lineage.parentThreadId : null;
  if (parentThreadId != null) {
    return (
      <SendToMain
        threadRef={threadRef}
        parentRef={scopeThreadRef(threadRef.environmentId, parentThreadId)}
        message={props.message}
      />
    );
  }
  const { projectedItem } = props;
  if (
    projectedItem?.item.type !== "assistant_message" ||
    projectedItem.item.runId === null ||
    projectedItem.sourceThreadId !== threadRef.threadId
  ) {
    return null;
  }
  return <SideChatFromHere threadRef={threadRef} projectedItem={projectedItem} />;
}

function findMessageSource(threadRef: ScopedThreadRef, message: ChatMessage): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-assistant-citation-source]")].find(
      (element) =>
        element.dataset.assistantCitationSource === message.id &&
        element.dataset.assistantCitationThread === threadRef.threadId &&
        element.dataset.assistantCitationEnvironment === threadRef.environmentId,
    ) ?? null
  );
}

/** Quotes a whole side chat reply into main's composer, with the comment box open. */
function SendToMain(props: {
  readonly threadRef: ScopedThreadRef;
  readonly parentRef: ScopedThreadRef;
  readonly message: ChatMessage;
}) {
  const mainComposer = useMainComposer();
  const { threadRef, message } = props;
  if (!message.text.trim()) return null;

  const send = () => {
    // The meta row can sit below tool rows, so the reply may be virtualized away.
    const source = findMessageSource(threadRef, message);
    const text = source ? readAssistantText(source).text : message.text;
    const selector = createAssistantTextSelector(
      text,
      text.length - text.trimStart().length,
      text.trimEnd().length,
    );
    if (selector === null) return;
    if (selector.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH) {
      toastManager.add({
        type: "warning",
        title: "This reply is too long to send whole",
        description: "Select the part you need and use Cite in main, or use Bring back.",
      });
      return;
    }
    const viewport = source?.closest<HTMLElement>("[data-assistant-citation-viewport]") ?? null;
    let sourceAnchor: AssistantCitationSourceAnchor | null = null;
    if (source !== null && viewport !== null) {
      const range = document.createRange();
      range.selectNodeContents(source);
      sourceAnchor = { source, range, viewport };
    }
    citeInComposer(mainComposer?.current, {
      threadRef: props.parentRef,
      citation: { version: 1, ...threadRef, messageId: message.id, ...selector },
      sourceAnchor,
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={send}
            aria-label="Send this reply to the main thread"
          />
        }
      >
        <MessageSquareShareIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Send this reply to the main thread</TooltipPopup>
    </Tooltip>
  );
}

/** Starts a side chat that knows the thread up to this reply. */
function SideChatFromHere(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectedItem: ProjectedItem;
}) {
  const { threadRef, projectedItem } = props;
  const ctx = use(TimelineRowCtx);
  const offered = useSideChatsOffered(useQuietThreadShell(threadRef));
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  const start = useStartSideChat(offered ? threadRef : null);
  const [busy, setBusy] = useState(false);
  const runId = projectedItem.item.runId;
  const canFork = canForkProjectedAssistantItem({
    projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  if (!offered || !canFork || runId === null) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            aria-label="Side chat from this response"
            onClick={() => {
              setBusy(true);
              void start.open(undefined, runId).finally(() => setBusy(false));
            }}
          />
        }
      >
        <MessagesSquareIcon className={cn("size-3", busy && "animate-pulse")} />
      </TooltipTrigger>
      <TooltipPopup side="top">Side chat from this response</TooltipPopup>
    </Tooltip>
  );
}
