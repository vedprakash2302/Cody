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

type DraftAnswers = Record<string, PendingUserInputDraftAnswer>;

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
 * composer answers them. Drafts live here rather than in the composer draft
 * store, which belongs to the routed thread.
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
  const [draftsByRequestId, setDraftsByRequestId] = useState<Record<string, DraftAnswers>>({});
  const [questionIndexByRequestId, setQuestionIndexByRequestId] = useState<Record<string, number>>(
    {},
  );

  const requests = projection === null ? null : derivePendingThreadRequests(projection);
  const pendingApprovals = derivePendingApprovals(requests?.approvals ?? []);
  const pendingUserInputs = derivePendingUserInputs(requests?.userInputs ?? []);
  const activeApproval = pendingApprovals[0] ?? null;
  const activeUserInput = activeApproval === null ? (pendingUserInputs[0] ?? null) : null;
  const activeDrafts: DraftAnswers = activeUserInput
    ? seedUserInputDraftAnswers(
        activeUserInput.questions,
        draftsByRequestId[activeUserInput.requestId] ?? {},
      )
    : {};
  const progress = activeUserInput
    ? derivePendingUserInputProgress(
        activeUserInput.questions,
        activeDrafts,
        questionIndexByRequestId[activeUserInput.requestId] ?? 0,
      )
    : null;

  const withResponding = async <A>(requestId: RuntimeRequestId, run: () => Promise<A>) => {
    setRespondingRequestIds((ids) => [...ids, requestId]);
    try {
      return await run();
    } finally {
      setRespondingRequestIds((ids) => ids.filter((id) => id !== requestId));
    }
  };

  const updateActiveDraft = (
    questionId: string,
    change: (draft: PendingUserInputDraftAnswer | undefined) => PendingUserInputDraftAnswer,
  ) => {
    if (activeUserInput === null) return;
    setDraftsByRequestId((current) => ({
      ...current,
      [activeUserInput.requestId]: {
        ...activeDrafts,
        [questionId]: change(activeDrafts[questionId]),
      },
    }));
  };

  const setQuestionIndex = (index: number) => {
    if (activeUserInput === null) return;
    setQuestionIndexByRequestId((current) => ({
      ...current,
      [activeUserInput.requestId]: index,
    }));
  };

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
        return result;
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
      });
    },
    dismiss: (requestId: RuntimeRequestId) => {
      void withResponding(requestId, async () => {
        const result = await dismissUserInput({
          environmentId: sideRef.environmentId,
          input: { threadId: sideRef.threadId, requestId },
        });
        if (result._tag === "Failure") reportFailure("Couldn't dismiss the question", result);
      });
    },
  };
}

export type SideChatRequests = ReturnType<typeof useSideChatRequests>;
