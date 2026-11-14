import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  AssistantCitation,
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { carriedThroughRunId, newerFinishedRuns } from "@t3tools/shared/codySideChats";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import { useComposerDraftStore } from "../composerDraftStore";
import { dispatchSnapShotComposerFocus } from "../lib/desktopSnapShot";
import type { AssistantCitationSourceAnchor } from "../lib/assistantTextSelection";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/models";
import { readThreadShell, useQuietThreadProjection } from "../state/entities";
import { environmentThreadDetails, environmentThreadShells } from "../state/threads";
import { holdCommentFocus, quoteIntoSideChatComposer } from "./sideChatComposers";

const SIDE_CHAT_SURFACE_PREFIX = "side-chat:";

type CarriedThrough = Parameters<typeof carriedThroughRunId>[0];

interface SideChatChoice {
  readonly id: ThreadId;
  readonly createdAt: string;
}

/** The side chat's latest reply is still on its way. */
export function sideChatWorking(shell: Pick<EnvironmentThreadShell, "latestRun">): boolean {
  const status = shell.latestRun?.status;
  return (
    status === "preparing" || status === "queued" || status === "starting" || status === "running"
  );
}

/** The side chat a right panel surface shows, if it shows one. */
function sideChatOfSurface(surfaceId: string | null | undefined): ThreadId | null {
  return surfaceId?.startsWith(SIDE_CHAT_SURFACE_PREFIX)
    ? (surfaceId.slice(SIDE_CHAT_SURFACE_PREFIX.length) as ThreadId)
    : null;
}

/** Side chats in the order they started, the order their tabs and numbers use. */
export function orderSideChats<T extends SideChatChoice>(sideChats: ReadonlyArray<T>): T[] {
  return sideChats.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** The side chat in use: the one whose tab is active, else the newest one. */
export function pickSideChat<T extends SideChatChoice>(
  sideChats: ReadonlyArray<T>,
  activeSurfaceId: string | null | undefined,
): T | null {
  const activeId = sideChatOfSurface(activeSurfaceId);
  return (
    sideChats.find((sideChat) => sideChat.id === activeId) ??
    orderSideChats(sideChats).at(-1) ??
    null
  );
}

/** The parent's side chat in use: the one whose tab is active, else the newest one. */
export function sideChatInUse(parentRef: ScopedThreadRef): ThreadId | null {
  const sideChats = appAtomRegistry.get(environmentThreadShells.sideChatsAtom(parentRef));
  const active = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    parentRef,
  ).activeSurfaceId;
  return pickSideChat(sideChats, active)?.id ?? null;
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

/**
 * Roughly how much a Bring back would add to main's context: the text of the
 * side chat's finished replies main hasn't received, the turns the server
 * sends. The server also adds the side chat's edits, so this runs a little low.
 */
export function bringBackSize(
  sideChat: {
    readonly runs: CarriedThrough["sourceRuns"];
    readonly messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "runId" | "text">>;
  } | null,
  main: CarriedThrough["carrier"] | null,
  sideChatId: ThreadId,
): { readonly newReplies: number; readonly tokens: number } {
  if (sideChat === null || main === null) return { newReplies: 0, tokens: 0 };
  const seenRunId = carriedThroughRunId({
    startRunId: null,
    sourceThreadId: sideChatId,
    sourceRuns: sideChat.runs,
    carrier: main,
  });
  const { newRuns } = newerFinishedRuns(seenRunId, sideChat.runs);
  const runIds = new Set(newRuns.map((run) => run.id));
  let characters = 0;
  for (const message of sideChat.messages) {
    if (message.runId !== null && runIds.has(message.runId)) characters += message.text.length;
  }
  return { newReplies: newRuns.length, tokens: Math.ceil(characters / 4) };
}

/** "~400", "~3k": a token count rough enough to show as an estimate. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `~${Math.max(10, Math.round(tokens / 10) * 10)}`;
  return `~${Math.round(tokens / 1000)}k`;
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
 * Quotes main thread text into one of its side chats, opening its tab with
 * the comment box over the quoted text. With main's update pending, the quote
 * carries it too, since it may be newer than what the side chat has seen.
 */
export function quoteInSideChat(
  parentRef: ScopedThreadRef,
  sideChatId: ThreadId,
  citation: AssistantCitation,
  sourceAnchor: AssistantCitationSourceAnchor,
) {
  const sideChatRef = scopeThreadRef(parentRef.environmentId, sideChatId);
  const { newReplies, wentBack } = readSideChatCatchUp(sideChatRef, parentRef);
  if (newReplies > 0 || wentBack) addCatchUp(sideChatRef, parentRef);
  holdCommentFocus();
  useRightPanelStore.getState().openSideChat(parentRef, sideChatId);
  quoteIntoSideChatComposer(sideChatRef, citation, sourceAnchor);
}

export const SUMMARY_PROMPT =
  "Summarize this side chat for the main thread. Keep the conclusions, decisions, and any code, commands, or file paths worth reusing. Leave out the back-and-forth. Reply with only the summary.";

/**
 * Where a requested summary stands: the reply to `messageId` once its run
 * finished, or why there is none.
 */
export function summaryReply(
  sideChat: {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">>;
    readonly messages: ReadonlyArray<
      Pick<OrchestrationV2ConversationMessage, "runId" | "role" | "text">
    >;
  } | null,
  messageId: MessageId,
):
  | { readonly status: "pending" }
  | { readonly status: "failed" }
  | { readonly status: "done"; readonly text: string } {
  const run = sideChat?.runs.find((candidate) => candidate.userMessageId === messageId);
  if (sideChat === null || run === undefined) return { status: "pending" };
  if (run.status === "completed") {
    const text = sideChat.messages
      .filter((message) => message.runId === run.id && message.role === "assistant")
      .map((message) => message.text.trim())
      .filter((part) => part.length > 0)
      .at(-1);
    return text === undefined ? { status: "failed" } : { status: "done", text };
  }
  if (
    run.status === "failed" ||
    run.status === "interrupted" ||
    run.status === "cancelled" ||
    run.status === "rolled_back"
  ) {
    return { status: "failed" };
  }
  return { status: "pending" };
}

/** The text a summary adds to main's next message. */
export function summaryForMain(title: string, summary: string): string {
  return `Summary of side chat "${title}":\n\n${summary}\n\n`;
}
