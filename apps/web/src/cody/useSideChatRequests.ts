import {
  derivePendingThreadRequests,
  seedUserInputDraftAnswers,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  OrchestrationV2ThreadProjection,
  ProviderApprovalDecision,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { sideChatRequestKey, useSideChatDraftStore } from "./sideChats";

type DraftAnswers = Record<string, PendingUserInputDraftAnswer>;

const NO_ANSWERS: DraftAnswers = {};

// Outside React state so a second Enter before the next render, or after the
// panel remounts, can't answer the same request twice.
const respondingKeys = new Set<string>();

const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error && error.message.length > 0 ? error.message : undefined,
  });
};

/**
 * A side chat's pending approvals and questions, answered the way the main
 * composer answers them. Answers live in the side chat's store rather than the
 * composer draft store, which belongs to the routed thread.
 */
export function useSideChatRequests(
  sideRef: ScopedThreadRef,
  projection: OrchestrationV2ThreadProjection | null,
) {
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissUserInput = useOrchestrationCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);

  const requests = projection === null ? null : derivePendingThreadRequests(projection);
  const pendingApprovals = derivePendingApprovals(requests?.approvals ?? []);
  const pendingUserInputs = derivePendingUserInputs(requests?.userInputs ?? []);
  const activeApproval = pendingApprovals[0] ?? null;
  const activeUserInput = activeApproval === null ? (pendingUserInputs[0] ?? null) : null;
  const questionKey =
    activeUserInput === null
      ? null
      : sideChatRequestKey(sideRef.threadId, activeUserInput.requestId);
  const stored = useSideChatDraftStore((state) =>
    questionKey === null ? undefined : state.questions[questionKey],
  );
  const seed = (answers: Readonly<DraftAnswers> | undefined): DraftAnswers =>
    activeUserInput === null
      ? NO_ANSWERS
      : seedUserInputDraftAnswers(activeUserInput.questions, answers ?? NO_ANSWERS);
  const activeDrafts = seed(stored?.answers);
  const progress = activeUserInput
    ? derivePendingUserInputProgress(
        activeUserInput.questions,
        activeDrafts,
        stored?.questionIndex ?? 0,
      )
    : null;

  const withResponding = async (requestId: RuntimeRequestId, run: () => Promise<void>) => {
    const key = sideChatRequestKey(sideRef.threadId, requestId);
    if (respondingKeys.has(key)) return;
    respondingKeys.add(key);
    setRespondingRequestIds((ids) => [...ids, requestId]);
    try {
      await run();
    } finally {
      respondingKeys.delete(key);
      setRespondingRequestIds((ids) => ids.filter((id) => id !== requestId));
    }
  };

  const updateActiveDraft = (
    questionId: string,
    change: (draft: PendingUserInputDraftAnswer | undefined) => PendingUserInputDraftAnswer,
  ) => {
    if (questionKey === null) return;
    useSideChatDraftStore.getState().updateQuestion(questionKey, (current) => {
      const answers = seed(current?.answers);
      return {
        questionIndex: current?.questionIndex ?? 0,
        answers: { ...answers, [questionId]: change(answers[questionId]) },
      };
    });
  };

  const setQuestionIndex = (questionIndex: number) => {
    if (questionKey === null) return;
    useSideChatDraftStore.getState().updateQuestion(questionKey, (current) => ({
      answers: current?.answers ?? {},
      questionIndex,
    }));
  };

  const forgetAnswers = (requestId: RuntimeRequestId) =>
    useSideChatDraftStore
      .getState()
      .updateQuestion(sideChatRequestKey(sideRef.threadId, requestId), () => null);

  return {
    pendingApprovals,
    pendingUserInputs,
    activeApproval,
    activeUserInput,
    activeDrafts,
    progress,
    respondingRequestIds,
    isResponding:
      activeUserInput !== null && respondingRequestIds.includes(activeUserInput.requestId),
    respondToApproval: (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) =>
      withResponding(requestId, async () => {
        const result = await respondToApproval({
          environmentId: sideRef.environmentId,
          input: { threadId: sideRef.threadId, requestId, decision },
        });
        if (result._tag === "Failure") reportFailure("Couldn't answer the request", result);
      }),
    toggleOption: (questionId: string, optionValue: string) => {
      const question = activeUserInput?.questions.find((entry) => entry.id === questionId);
      if (question === undefined) return;
      updateActiveDraft(questionId, (draft) =>
        togglePendingUserInputOptionSelection(question, draft, optionValue),
      );
    },
    setCustomAnswer: (text: string) => {
      const question = progress?.activeQuestion;
      if (question == null) return;
      updateActiveDraft(question.id, (draft) =>
        setPendingUserInputCustomAnswer(draft, text, question),
      );
    },
    previousQuestion: () => {
      if (progress !== null) setQuestionIndex(Math.max(progress.questionIndex - 1, 0));
    },
    advance: () => {
      if (
        activeUserInput === null ||
        progress === null ||
        activeUserInput.responseCapability === "not_resumable"
      ) {
        return;
      }
      if (!progress.isLastQuestion) {
        setQuestionIndex(progress.questionIndex + 1);
        return;
      }
      const answers = buildPendingUserInputAnswers(activeUserInput.questions, activeDrafts);
      if (answers === null) return;
      const requestId = activeUserInput.requestId;
      void withResponding(requestId, async () => {
        const result = await respondToUserInput({
          environmentId: sideRef.environmentId,
          input: { threadId: sideRef.threadId, requestId, answers },
        });
        if (result._tag === "Failure") reportFailure("Couldn't send your answer", result);
        else forgetAnswers(requestId);
      });
    },
    dismiss: (requestId: RuntimeRequestId) => {
      void withResponding(requestId, async () => {
        const result = await dismissUserInput({
          environmentId: sideRef.environmentId,
          input: { threadId: sideRef.threadId, requestId },
        });
        if (result._tag === "Failure") reportFailure("Couldn't dismiss the question", result);
        else forgetAnswers(requestId);
      });
    },
  };
}

export type SideChatRequests = ReturnType<typeof useSideChatRequests>;
