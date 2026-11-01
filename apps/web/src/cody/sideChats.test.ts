import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
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
