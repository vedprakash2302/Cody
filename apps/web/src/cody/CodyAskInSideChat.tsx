import type { AssistantCitation, ScopedThreadRef } from "@t3tools/contracts";
import { MessagesSquareIcon } from "lucide-react";

import { useSideChat } from "../components/chat/useSideChat";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { useQuietThreadShell } from "../state/entities";
import { useSideChatsOffered } from "./sideChatPalette";
import { readParentComposerSettings } from "./sideChatSettings";
import { quoteInSideChat, sideChatInUse } from "./sideChats";

/**
 * "Ask in side chat" beside the selection toolbar's Cite: quotes the selected
 * text into the thread's side chat in use, starting one when it has none.
 * Shown only where upstream offers side chats.
 */
export function CodyAskInSideChat(props: {
  readonly threadRef: ScopedThreadRef;
  readonly citation: AssistantCitation;
  readonly disabled: boolean;
  readonly onDone: () => void;
}) {
  const { threadRef } = props;
  const offered = useSideChatsOffered(useQuietThreadShell(threadRef));
  const sideChat = useSideChat({
    threadRef: offered ? threadRef : null,
    readSettings: () => readParentComposerSettings(threadRef),
    onError: (message) =>
      toastManager.add({
        type: "error",
        title: "Could not start a side chat",
        description: message,
      }),
  });
  if (!offered) return null;

  const ask = async () => {
    const citation = props.citation;
    props.onDone();
    const existing = sideChatInUse(threadRef);
    if (existing !== null) {
      quoteInSideChat(threadRef, existing, citation);
      return;
    }
    if (!(await sideChat.open())) return;
    const started = sideChatInUse(threadRef);
    if (started !== null) quoteInSideChat(threadRef, started, citation);
  };

  return (
    <Button
      type="button"
      size="xs"
      variant="glass"
      disabled={props.disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => void ask()}
    >
      <MessagesSquareIcon aria-hidden="true" className="size-3.5" />
      Ask in side chat
    </Button>
  );
}
