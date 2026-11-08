import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
} from "@t3tools/contracts";
import { MessagesSquareIcon } from "lucide-react";
import { Atom } from "effect/reactivity";

import { useSideChat } from "../components/chat/useSideChat";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";
import { useServerConfigs } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { environmentThreadShells } from "../state/threads";
import { readParentComposerSettings } from "./sideChatSettings";
import { sideChatInUse } from "./sideChats";

const NO_SIDE_CHATS = Atom.make<ReadonlyArray<unknown>>([]).pipe(
  Atom.withLabel("cody-side-chats:none"),
);

/** Whether upstream offers side chats on this thread, as its composer does. */
export function useSideChatsOffered(thread: EnvironmentThreadShell | null | undefined): boolean {
  const capable =
    useServerConfigs().get(thread?.environmentId ?? ("" as EnvironmentId))?.environment.capabilities
      .sideChats === true;
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? ("" as EnvironmentId),
    AuthOrchestrationOperateScope,
  );
  return (
    capable &&
    canOperate &&
    thread != null &&
    thread.lineage.sideChat !== true &&
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.delegatedFrom === null
  );
}

/** "New side chat" and "Open side chat" for the active thread. */
export function useCodySideChatPaletteItems(
  thread: EnvironmentThreadShell | null | undefined,
): ReadonlyArray<CommandPaletteActionItem> {
  const offered = useSideChatsOffered(thread);
  const threadRef =
    offered && thread != null ? scopeThreadRef(thread.environmentId, thread.id) : null;
  const sideChat = useSideChat({
    threadRef,
    readSettings: () =>
      threadRef === null
        ? { runtimeMode: DEFAULT_RUNTIME_MODE, modelSelection: undefined }
        : readParentComposerSettings(threadRef),
    onError: (message) =>
      toastManager.add({
        type: "error",
        title: "Could not start a side chat",
        description: message,
      }),
  });
  const hasSideChats =
    useAtomValue(
      threadRef === null ? NO_SIDE_CHATS : environmentThreadShells.sideChatsAtom(threadRef),
    ).length > 0;
  if (threadRef === null) return [];
  const searchTerms = ["side chat", "side", "btw", "ask", "question"];
  return [
    {
      kind: "action",
      value: "action:new-side-chat",
      searchTerms: [...searchTerms, "new"],
      title: "New side chat",
      icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.sideChat",
      run: async () => {
        await sideChat.open();
      },
    },
    ...(hasSideChats
      ? [
          {
            kind: "action" as const,
            value: "action:open-side-chat",
            searchTerms,
            title: "Open side chat",
            icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
            run: async () => {
              const sideChatId = sideChatInUse(threadRef);
              if (sideChatId !== null) {
                useRightPanelStore.getState().openSideChat(threadRef, sideChatId);
              }
            },
          },
        ]
      : []),
  ];
}
