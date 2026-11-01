import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { carriedThroughRunId, newerFinishedRuns } from "@t3tools/shared/codySideChats";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import { formatAssistantCitationForComposer } from "../composer-logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { dispatchSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import { readThreadShell, useQuietThreadProjection } from "../state/entities";
import { environmentThreadDetails, environmentThreadShells } from "../state/threads";

const SIDE_CHAT_SURFACE_PREFIX = "side-chat:";

/** The parent's side chat in use: the one whose tab is active, else the newest one. */
export function sideChatInUse(parentRef: ScopedThreadRef): ThreadId | null {
  const sideChats = appAtomRegistry.get(environmentThreadShells.sideChatsAtom(parentRef));
  if (sideChats.length === 0) return null;
  const active = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    parentRef,
  ).activeSurfaceId;
  const activeId = active?.startsWith(SIDE_CHAT_SURFACE_PREFIX)
    ? active.slice(SIDE_CHAT_SURFACE_PREFIX.length)
    : null;
  const inUse =
    sideChats.find((sideChat) => sideChat.id === activeId) ??
    sideChats.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return inUse?.id ?? null;
}

/** Adds `chip`'s thread to the next message in `targetRef`'s composer, once. */
function addThreadChip(targetRef: ScopedThreadRef, chipRef: ScopedThreadRef, title: string) {
  const store = useComposerDraftStore.getState();
  const record = threadContextRecord(chipRef, title);
  if (
    store
      .getComposerDraft(targetRef)
      ?.threadContexts.some((existing) => existing.contextId === record.contextId)
  ) {
    return;
  }
  store.addThreadContexts(targetRef, [record]);
}

function catchUpOf(
  sideChat: ThreadStructure | null,
  main: ThreadStructure | null,
  parentThreadId: ThreadId,
) {
  if (sideChat === null || main === null) return { newReplies: 0, wentBack: false };
  const forkedFrom = sideChat.thread.forkedFrom;
  const seenRunId = carriedThroughRunId({
    startRunId: forkedFrom?.type === "run" ? forkedFrom.runId : null,
    sourceThreadId: parentThreadId,
    sourceRuns: main.runs,
    carrier: sideChat,
  });
  const { newRuns, wentBack } = newerFinishedRuns(seenRunId, main.runs);
  return { newReplies: newRuns.length, wentBack };
}

/**
 * What a side chat hasn't seen of its main thread: main's finished replies
 * since the fork or the last catch-up the side chat sent. The server builds
 * the catch-up from the same records when the message starts.
 */
export function useSideChatCatchUp(sideChatRef: ScopedThreadRef, parentRef: ScopedThreadRef) {
  const sideChat = useQuietThreadProjection(sideChatRef)?.projection ?? null;
  const main = useQuietThreadProjection(parentRef)?.projection ?? null;
  return catchUpOf(sideChat, main, parentRef.threadId);
}

/** `useSideChatCatchUp` outside React; nothing new when either thread isn't loaded. */
function readSideChatCatchUp(sideChatRef: ScopedThreadRef, parentRef: ScopedThreadRef) {
  const read = (ref: ScopedThreadRef) =>
    appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(ref))?.projection ?? null;
  return catchUpOf(read(sideChatRef), read(parentRef), parentRef.threadId);
}

/** Puts main's update in the side chat's next message, as main's thread chip. */
export function addCatchUp(sideChatRef: ScopedThreadRef, parentRef: ScopedThreadRef) {
  addThreadChip(sideChatRef, parentRef, readThreadShell(parentRef)?.title ?? "Main thread");
}

/**
 * Brings a side chat back into its main thread's next message, as its thread
 * chip. The server sends what the side chat said since main last received it,
 * also when that message steers a running turn.
 */
export function bringBackSideChat(sideChatRef: ScopedThreadRef, parentRef: ScopedThreadRef) {
  addThreadChip(parentRef, sideChatRef, readThreadShell(sideChatRef)?.title ?? "Side chat");
  dispatchSnapShotComposerFocus();
}

/**
 * Quotes main thread text into one of its side chats, opening its tab. With
 * main's update pending, the quote carries it too, since it may be newer than
 * what the side chat has seen.
 */
export function quoteInSideChat(
  parentRef: ScopedThreadRef,
  sideChatId: ThreadId,
  citation: AssistantCitation,
) {
  const sideChatRef = scopeThreadRef(parentRef.environmentId, sideChatId);
  const { newReplies, wentBack } = readSideChatCatchUp(sideChatRef, parentRef);
  const store = useComposerDraftStore.getState();
  const prompt = store.getComposerDraft(sideChatRef)?.prompt ?? "";
  const separator = prompt.length === 0 || /\s$/.test(prompt) ? "" : " ";
  store.setPrompt(
    sideChatRef,
    `${prompt}${separator}${formatAssistantCitationForComposer(citation)}`,
  );
  if (newReplies > 0 || wentBack) addCatchUp(sideChatRef, parentRef);
  useRightPanelStore.getState().openSideChat(parentRef, sideChatId);
}
