import type { UserInputQuestion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePendingUserInputProgress } from "../pendingUserInput";
import { planSideChatAdvance } from "./sideChatAnswers";
import useSideChatRequests from "./useSideChatRequests.ts?raw";

const questions: ReadonlyArray<UserInputQuestion> = [
  {
    id: "scope",
    header: "Scope",
    question: "Which scope?",
    options: [{ label: "Incremental", description: "Small steps" }],
    multiSelect: false,
  },
  {
    id: "notes",
    header: "Notes",
    question: "Anything else?",
    options: [],
    allowCustomAnswer: true,
    multiSelect: false,
  },
];

const advance = (drafts: Parameters<typeof planSideChatAdvance>[2], questionIndex: number) =>
  planSideChatAdvance(
    derivePendingUserInputProgress(questions, drafts, questionIndex),
    questions,
    drafts,
  );

// Upstream moved the answer helpers into client-runtime and stopped Enter from
// skipping an unanswered question. Side chats answer the same way.
describe("side chat question answers", () => {
  it("stay on an unanswered question and move on once it has an answer", () => {
    expect(advance({}, 0)).toEqual({ type: "stay" });
    expect(advance({ scope: { selectedOptionValues: ["Incremental"] } }, 0)).toEqual({
      type: "next",
      questionIndex: 1,
    });
  });

  it("submit every answer from the last question", () => {
    expect(
      advance(
        { scope: { selectedOptionValues: ["Incremental"] }, notes: { customAnswer: "Ship it" } },
        1,
      ),
    ).toEqual({ type: "submit", answers: { scope: "Incremental", notes: "Ship it" } });
  });

  it("are what the side chat's question card sends", () => {
    expect(useSideChatRequests).toContain("planSideChatAdvance(progress,");
    expect(useSideChatRequests).toContain(
      'from "@t3tools/client-runtime/state/pending-user-input"',
    );
  });
});
