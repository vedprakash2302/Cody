import {
  buildPendingUserInputAnswers,
  type PendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
  type PendingUserInputQuestion,
} from "@t3tools/client-runtime/state/pending-user-input";

import type { PendingUserInputProgress } from "../pendingUserInput";

type SideChatAdvance =
  | { readonly type: "stay" }
  | { readonly type: "next"; readonly questionIndex: number }
  | { readonly type: "submit"; readonly answers: Record<string, PendingUserInputAnswer> };

/** What Enter or Next does in a side chat's question card, matching the main composer. */
export function planSideChatAdvance(
  progress: Pick<PendingUserInputProgress, "canAdvance" | "isLastQuestion" | "questionIndex">,
  questions: ReadonlyArray<PendingUserInputQuestion>,
  drafts: Record<string, PendingUserInputDraftAnswer>,
): SideChatAdvance {
  if (!progress.canAdvance) return { type: "stay" };
  if (!progress.isLastQuestion) return { type: "next", questionIndex: progress.questionIndex + 1 };
  const answers = buildPendingUserInputAnswers(questions, drafts);
  return answers === null ? { type: "stay" } : { type: "submit", answers };
}
