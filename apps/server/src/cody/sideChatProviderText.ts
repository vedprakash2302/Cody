import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import {
  projectComposerContextForProvider,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import type { SideChatMembershipShape } from "./SideChatStore.ts";
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
  const mainMessages =
    state.newRuns.length === 0
      ? []
      : (yield* projectionStore.getThreadRecords(state.parentThreadId, ["messages"], {
          messageRunIds: state.newRuns.map((run) => run.id),
        })).messages;
  const update = renderMainUpdate({
    mainTitle: state.mainTitle,
    newRuns: state.newRuns,
    messages: mainMessages,
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
