import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentThreadDetails } from "../state/threads";
import { appendToDraft } from "./sideChatComposers";
import { summaryForMain, summaryReply } from "./sideChats";

/** Side chats with a summary on its way to main, by side chat key. */
const useSummaryRequests = create<{ readonly byKey: Readonly<Record<string, MessageId>> }>(() => ({
  byKey: {},
}));
const stopWatching = new Map<string, () => void>();

function finish(key: string) {
  stopWatching.get(key)?.();
  stopWatching.delete(key);
  useSummaryRequests.setState(({ byKey }) => {
    const { [key]: _finished, ...rest } = byKey;
    return { byKey: rest };
  });
}

export function isSummarizing(sideChatRef: ScopedThreadRef): boolean {
  return useSummaryRequests.getState().byKey[scopedThreadKey(sideChatRef)] !== undefined;
}

/** Whether the side chat is writing a summary for main. */
export function useSummarizing(sideChatRef: ScopedThreadRef): boolean {
  const key = scopedThreadKey(sideChatRef);
  return useSummaryRequests((state) => state.byKey[key] !== undefined);
}

/**
 * Hands the reply to `messageId` to main's draft once its run finishes. The
 * watch lives outside React, so it delivers after the side chat's tab closes;
 * a reload drops it, and the reply's Send to main still works.
 */
export function watchSummary(input: {
  readonly sideChatRef: ScopedThreadRef;
  readonly parentRef: ScopedThreadRef;
  readonly messageId: MessageId;
}) {
  const key = scopedThreadKey(input.sideChatRef);
  finish(key);
  useSummaryRequests.setState(({ byKey }) => ({ byKey: { ...byKey, [key]: input.messageId } }));
  const atom = environmentThreadDetails.quietThreadAtom(input.sideChatRef);
  const statusAtom = environmentThreadDetails.statusAtom(input.sideChatRef);
  const check = () => {
    if (useSummaryRequests.getState().byKey[key] !== input.messageId) return;
    // A deleted side chat's projection reads as null, which would look pending forever.
    if (appAtomRegistry.get(statusAtom) === "deleted") {
      finish(key);
      return;
    }
    const reply = summaryReply(appAtomRegistry.get(atom)?.projection ?? null, input.messageId);
    if (reply.status === "pending") return;
    // Claimed before delivering, so a second notification can't add it twice.
    finish(key);
    if (reply.status === "failed") {
      toastManager.add({ type: "error", title: "The side chat did not finish the summary" });
      return;
    }
    const title = readThreadShell(input.sideChatRef)?.title ?? "Side chat";
    appendToDraft(input.parentRef, summaryForMain(title, reply.text), "\n\n");
    toastManager.add({
      type: "success",
      title: "Summary added",
      description: "It's in the main thread's next message, where you can edit it.",
    });
  };
  const stopProjection = appAtomRegistry.subscribe(atom, check);
  const stopStatus = appAtomRegistry.subscribe(statusAtom, check);
  stopWatching.set(key, () => {
    stopProjection();
    stopStatus();
  });
  check();
}

/** Drops a summary request whose turn never started. */
export function cancelSummary(sideChatRef: ScopedThreadRef) {
  finish(scopedThreadKey(sideChatRef));
}
