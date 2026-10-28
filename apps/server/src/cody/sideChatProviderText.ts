import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  ThreadId,
} from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import {
  projectComposerContextForProvider,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import type { SideChatMembershipShape } from "./SideChatStore.ts";
import { ACTIVITY_ITEM_TYPES } from "./conversationDigest.ts";
import { attachedSideChatRecords, sideChatAttachmentText } from "./sideChatAttach.ts";
import { mainUpdateRecord, readSideChatMainState, renderMainUpdate } from "./sideChatMainUpdate.ts";
import { withSideChatRules } from "./sideChatRules.ts";

/**
 * The text a side chat turn sends its provider. A message carrying main's
 * thread chip gets what main finished since the side chat last saw it, built
 * when the turn starts, and records how far that went.
 */
export const sideChatProviderText = Effect.fn("SideChat.providerText")(function* (input: {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly sideChats: SideChatMembershipShape;
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "forkedFrom">;
  readonly message: Pick<OrchestrationV2ConversationMessage, "id" | "text" | "context">;
}) {
  const { projectionStore, sideChats, thread, message } = input;
  const records = message.context?.records ?? [];
  const parentThreadId = thread.lineage.parentThreadId;
  const record = parentThreadId === null ? null : mainUpdateRecord(message, parentThreadId);
  if (record === null) {
    return withSideChatRules(
      expandAssistantCitationsForProvider(
        projectComposerContextForProvider({ text: message.text, records }),
      ),
    );
  }

  const question = expandAssistantCitationsForProvider(
    projectComposerContextForProvider({
      text: replaceComposerContextReferences(message.text, (occurrence) =>
        occurrence.contextId === record.contextId ? "" : occurrence.source,
      ).trim(),
      records: records.filter((candidate) => candidate.contextId !== record.contextId),
    }).trim(),
  );
  // A retried start must not count its own earlier attempt as seen.
  const state = yield* readSideChatMainState({
    projectionStore,
    thread,
    catchUps: sideChats.catchUps(thread.id),
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
  const seenRunId = state.newRuns.at(-1)?.id ?? state.seen?.id;
  if (seenRunId !== undefined) {
    // Without the record the next catch-up repeats this one, which is harmless.
    yield* sideChats
      .recordCatchUp(thread.id, message.id, seenRunId)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Couldn't record a side chat catch-up.", cause),
        ),
      );
  }
  return withSideChatRules(question.length === 0 ? update : `${update}\n\n${question}`);
});

/**
 * The text a thread message sends its provider when it carries attached side
 * chats: each side chat's turns the thread hasn't received, then the message.
 * `record` notes how far each side chat went, for the next attach to skip.
 */
const attachedSideChatsText = Effect.fn("SideChat.attachedText")(function* (input: {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly sideChats: SideChatMembershipShape;
  readonly threadId: ThreadId;
  readonly message: Pick<OrchestrationV2ConversationMessage, "id" | "text" | "context">;
}) {
  const { projectionStore, sideChats, message } = input;
  if (sideChats.isSideChat(input.threadId)) return null;
  const attached = attachedSideChatRecords(message, sideChats.isSideChat);
  if (attached.length === 0) return null;
  const attachedIds = new Set(attached.map((record) => record.contextId));
  const question = projectComposerContextForProvider({
    text: replaceComposerContextReferences(message.text, (occurrence) =>
      attachedIds.has(occurrence.contextId) ? "" : occurrence.source,
    ).trim(),
    records: (message.context?.records ?? []).filter(
      (candidate) => !attachedIds.has(candidate.contextId),
    ),
  }).trim();
  const attachments = yield* Effect.forEach(attached, (record) =>
    sideChatAttachmentText({
      projectionStore,
      sideChatId: record.threadId,
      threadId: input.threadId,
      messageId: message.id,
      sent: sideChats.sentToThread(record.threadId),
      withoutQuestion: question.length === 0,
    }).pipe(Effect.map((attachment) => ({ ...attachment, sideChatId: record.threadId }))),
  );
  const record = Effect.forEach(
    attachments,
    ({ sideChatId, coveredRunId }) =>
      coveredRunId === null
        ? Effect.void
        : sideChats.recordSentToThread(sideChatId, message.id, coveredRunId),
    { discard: true },
  ).pipe(
    // Without the record the next attach repeats this one, which is harmless.
    Effect.catchCause((cause) =>
      Effect.logWarning("Couldn't record an attached side chat.", cause),
    ),
  );
  const text = [
    ...attachments.map((attachment) => attachment.text),
    ...(question.length === 0 ? [] : [question]),
  ].join("\n\n");
  return { text, record };
});

/**
 * Cody's text for a turn's provider, or null to leave upstream's: a side
 * chat's turns get its rules and main's update, and a thread message that
 * carries side chats gets what they said.
 */
export const codyProviderText = Effect.fn("Cody.providerText")(function* (input: {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly sideChats: SideChatMembershipShape;
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "forkedFrom">;
  readonly message: Pick<OrchestrationV2ConversationMessage, "id" | "text" | "context">;
}) {
  if (input.sideChats.isSideChat(input.thread.id)) return yield* sideChatProviderText(input);
  const attached = yield* attachedSideChatsText({ ...input, threadId: input.thread.id });
  if (attached === null) return null;
  // Recorded now; it counts only once the provider takes the turn.
  yield* attached.record;
  return attached.text;
});

/**
 * Cody's text for a message steered into a running thread turn, or null to
 * leave upstream's. Run `record` once the steer lands: a steered message has
 * no turn of its own to show it arrived. Side chat steers stay plain, since
 * the side chat's rules and main's updates travel with queued sends.
 */
export const codySteerText = attachedSideChatsText;
