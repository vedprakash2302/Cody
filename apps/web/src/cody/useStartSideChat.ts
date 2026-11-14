import { DEFAULT_RUNTIME_MODE, type ScopedThreadRef } from "@t3tools/contracts";

import { useSideChat } from "../components/chat/useSideChat";
import { toastManager } from "../components/ui/toast";
import { readParentComposerSettings } from "./sideChatSettings";

/**
 * Starts side chats of `parentRef` from Cody's controls, with the settings the
 * parent's composer would send. Offers none when `parentRef` is null.
 */
export function useStartSideChat(parentRef: ScopedThreadRef | null) {
  return useSideChat({
    threadRef: parentRef,
    readSettings: () =>
      parentRef === null
        ? { runtimeMode: DEFAULT_RUNTIME_MODE, modelSelection: undefined }
        : readParentComposerSettings(parentRef),
    onError: (message) =>
      toastManager.add({
        type: "error",
        title: "Could not start a side chat",
        description: message,
      }),
  });
}
