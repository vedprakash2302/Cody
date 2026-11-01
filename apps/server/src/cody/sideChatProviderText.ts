import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import { linkedThreadChip, linkedThreadChips } from "@t3tools/shared/codySideChats";
import {
  projectComposerContextForProvider,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import { ACTIVITY_ITEM_TYPES } from "./conversationDigest.ts";
import { sideChatAttachmentText } from "./sideChatAttach.ts";
import { readSideChatMainState, renderMainUpdate } from "./sideChatMainUpdate.ts";
import { withSideChatRules } from "./sideChatRules.ts";

type Message = Pick<OrchestrationV2ConversationMessage, "id" | "text" | "context">;
type Thread = Pick<OrchestrationV2AppThread, "id" | "lineage" | "forkedFrom">;

/** The message's text for the provider without the chips Cody expands itself. */
function questionWithout(message: Message, contextIds: ReadonlySet<string>): string {
  return expandAssistantCitationsForProvider(
    projectComposerContextForProvider({
      text: replaceComposerContextReferences(message.text, (occurrence) =>
        contextIds.has(occurrence.contextId) ? "" : occurrence.source,
      ).trim(),
      records: (message.context?.records ?? []).filter(
        (candidate) => !contextIds.has(candidate.contextId),
      ),
    }).trim(),
  );
}

/**
 * The text a side chat turn sends its provider. A message carrying main's
 * thread chip gets what main finished since the side chat last saw it.
 */
export const sideChatProviderText = Effect.fn("SideChat.providerText")(function* (input: {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly thread: Thread;
  readonly message: Message;
}) {
  const { projectionStore, thread, message } = input;
  const parentThreadId = thread.lineage.parentThreadId;
  const record = parentThreadId === null ? null : linkedThreadChip(message, parentThreadId);
  if (record === null) return withSideChatRules(questionWithout(message, new Set()));

  const question = questionWithout(message, new Set([record.contextId]));
  // A retried start must not count its own earlier attempt as seen.
  const state = yield* readSideChatMainState({
    projectionStore,
    thread,
    excludeMessageId: message.id,
  });
  if (state === null) return withSideChatRules(question);
  const runIds = state.newRuns.map((run) => run.id);
  const main =
    runIds.length === 0
      ? { messages: [], turnItems: [] }
      : yield* projectionStore.getThreadRecords(state.parentThreadId, ["messages", "turnItems"], {
          messageRunIds: runIds,
          turnItemRunIds: runIds,
          turnItemTypes: [...ACTIVITY_ITEM_TYPES],
        });
  const update = renderMainUpdate({
    mainThreadId: state.parentThreadId,
    mainTitle: state.mainTitle,
    newRuns: state.newRuns,
    messages: main.messages,
    items: main.turnItems,
    checkpoints: state.checkpoints,
    wentBack: state.wentBack,
    withoutQuestion: question.length === 0,
  });
  return withSideChatRules(question.length === 0 ? update : `${update}\n\n${question}`);
});

/** The side chats of `threadId` that a message brings back: their chips it still links to. */
const broughtBackSideChats = Effect.fn("SideChat.broughtBack")(function* (input: {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly threadId: ThreadId;
  readonly message: Message;
}) {
  const chips = linkedThreadChips(input.message).filter(
    (record) => record.threadId !== input.threadId,
  );
  if (chips.length === 0) return [];
  const sideChats: Array<ThreadContextRecord> = [];
  for (const record of chips) {
    const shell = yield* input.projectionStore.getThreadShell(record.threadId);
    if (shell?.lineage.sideChat === true && shell.lineage.parentThreadId === input.threadId) {
      sideChats.push(record);
    }
  }
  return sideChats;
});

/**
 * The text a thread message sends its provider when it brings back side
 * chats: each side chat's turns the thread hasn't received, then the message.
 * Null when it brings back none.
 */
const broughtBackSideChatsText = Effect.fn("SideChat.broughtBackText")(function* (input: {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly threadId: ThreadId;
  readonly message: Message;
}) {
  const { projectionStore, message } = input;
  const sideChats = yield* broughtBackSideChats(input);
  if (sideChats.length === 0) return null;
  const question = questionWithout(message, new Set(sideChats.map((record) => record.contextId)));
  const blocks = yield* Effect.forEach(sideChats, (record) =>
    sideChatAttachmentText({
      projectionStore,
      sideChatId: record.threadId,
      threadId: input.threadId,
      messageId: message.id,
      withoutQuestion: question.length === 0,
    }),
  );
  return [...blocks, ...(question.length === 0 ? [] : [question])].join("\n\n");
});

/**
 * Cody's text for a turn's provider, or null to leave upstream's: a side
 * chat's turns get its rules and main's update, and a thread message that
 * brings back side chats gets what they said.
 */
export const codyProviderText = Effect.fn("Cody.providerText")(function* (input: {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly thread: Thread;
  readonly message: Message;
}) {
  if (input.thread.lineage.sideChat === true) return yield* sideChatProviderText(input);
  return yield* broughtBackSideChatsText({ ...input, threadId: input.thread.id });
});

/**
 * Cody's text for a message steered into a running thread turn, or null to
 * leave upstream's. Side chat steers stay plain, since the side chat's rules
 * and main's updates travel with the turns that start.
 */
export const codySteerText = broughtBackSideChatsText;
