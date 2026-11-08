import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { readThreadShell } from "../state/entities";

/**
 * What the thread's composer would send, for side chats started outside ChatView. Mirrors
 * ChatView's `runtimeMode` and its `composerSelectedModelSelection ?? thread` fallback.
 */
export function readParentComposerSettings(threadRef: ScopedThreadRef): {
  readonly runtimeMode: RuntimeMode;
  readonly modelSelection: ModelSelection | undefined;
} {
  const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
  const thread = readThreadShell(threadRef);
  return {
    runtimeMode: draft?.runtimeMode ?? thread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    modelSelection:
      (draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : undefined) ??
      thread?.modelSelection ??
      undefined,
  };
}
