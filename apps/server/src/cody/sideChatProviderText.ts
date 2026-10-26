import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  ThreadContextRecord,
} from "@t3tools/contracts";
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
    return withSideChatRules(projectComposerContextForProvider({ text: message.text, records }));
  }

  const question = projectComposerContextForProvider({
    text: replaceComposerContextReferences(message.text, (occurrence) =>
      occurrence.contextId === record.contextId ? "" : occurrence.source,
    ).trim(),
    records: records.filter((candidate) => candidate.contextId !== record.contextId),
  }).trim();
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
 * The text a thread turn sends its provider when its message carries attached
 * side chats: each side chat's turns the thread hasn't seen, then the message.
 */
const attachedSideChatsProviderText = Effect.fn("SideChat.attachedProviderText")(function* (input: {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly sideChats: SideChatMembershipShape;
  readonly thread: Pick<OrchestrationV2AppThread, "id">;
  readonly message: Pick<OrchestrationV2ConversationMessage, "id" | "text" | "context">;
  readonly records: ReadonlyArray<ThreadContextRecord>;
}) {
  const { projectionStore, sideChats, thread, message } = input;
  const attachedIds = new Set(input.records.map((record) => record.contextId));
  const question = projectComposerContextForProvider({
    text: replaceComposerContextReferences(message.text, (occurrence) =>
      attachedIds.has(occurrence.contextId) ? "" : occurrence.source,
    ).trim(),
    records: (message.context?.records ?? []).filter(
      (candidate) => !attachedIds.has(candidate.contextId),
    ),
  }).trim();
  const blocks = yield* Effect.forEach(input.records, (record) =>
    Effect.gen(function* () {
      const attachment = yield* sideChatAttachmentText({
        projectionStore,
        sideChatId: record.threadId,
        threadId: thread.id,
        messageId: message.id,
        sent: sideChats.sentToThread(record.threadId),
        withoutQuestion: question.length === 0,
      });
      if (attachment.coveredRunId !== null) {
        // Without the record the next attach repeats this one, which is harmless.
        yield* sideChats
          .recordSentToThread(record.threadId, message.id, attachment.coveredRunId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Couldn't record an attached side chat.", cause),
            ),
          );
      }
      return attachment.text;
    }),
  );
  return [...blocks, ...(question.length === 0 ? [] : [question])].join("\n\n");
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
  const records = attachedSideChatRecords(input.message, input.sideChats.isSideChat);
  if (records.length === 0) return null;
  return yield* attachedSideChatsProviderText({ ...input, records });
});
