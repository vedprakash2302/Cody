import {
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { messageRunId } from "./messageRunId";

const RECENT = MessageId.make("recent-answer");
const PAGED = MessageId.make("paged-answer");

const projection = {
  messages: [{ id: RECENT, runId: RunId.make("run-9") } as OrchestrationV2ConversationMessage],
  visibleTurnItems: [],
  turnItems: [
    {
      type: "assistant_message",
      messageId: PAGED,
      runId: RunId.make("run-3"),
    } as OrchestrationV2TurnItem,
  ],
};

describe("messageRunId", () => {
  it("finds a recent message's run", () => {
    expect(messageRunId(projection, RECENT)).toBe("run-9");
  });

  it("finds the run of an answer loaded by scrolling up, which has no message record", () => {
    expect(messageRunId(projection, PAGED)).toBe("run-3");
    expect(messageRunId(projection, MessageId.make("unknown"))).toBeNull();
  });
});
