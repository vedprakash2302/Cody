import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { readParentComposerSettings } from "./sideChatSettings";
import { addCatchUp, bringBackSideChat } from "./sideChats";

const environmentId = EnvironmentId.make("cody-side-chats-env");
const mainRef = scopeThreadRef(environmentId, ThreadId.make("cody-main"));
const sideChatRef = scopeThreadRef(environmentId, ThreadId.make("cody-side-chat"));

const chipsIn = (ref: typeof mainRef) =>
  (useComposerDraftStore.getState().getComposerDraft(ref)?.threadContexts ?? []).map(
    (record) => record.threadId,
  );

describe("side chat chips", () => {
  it("Bring back puts the side chat's chip in the main thread's next message, once", () => {
    bringBackSideChat(sideChatRef, mainRef);
    bringBackSideChat(sideChatRef, mainRef);
    expect(chipsIn(mainRef)).toEqual([sideChatRef.threadId]);
  });

  it("catching up puts main's chip in the side chat's next message", () => {
    addCatchUp(sideChatRef, mainRef);
    expect(chipsIn(sideChatRef)).toEqual([mainRef.threadId]);
  });
});

describe("side chats started from the palette or Ask in side chat", () => {
  it("start with what the parent's composer would send", () => {
    const parentRef = scopeThreadRef(environmentId, ThreadId.make("cody-settings-parent"));
    expect(readParentComposerSettings(parentRef)).toEqual({
      runtimeMode: DEFAULT_RUNTIME_MODE,
      modelSelection: undefined,
    });
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5",
    };
    useComposerDraftStore.getState().setRuntimeMode(parentRef, "approval-required");
    useComposerDraftStore.getState().setModelSelection(parentRef, modelSelection);
    expect(readParentComposerSettings(parentRef)).toEqual({
      runtimeMode: "approval-required",
      modelSelection: expect.objectContaining(modelSelection),
    });
  });
});
