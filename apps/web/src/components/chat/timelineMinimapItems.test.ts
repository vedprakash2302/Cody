import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";
import type { ChatMessage } from "../../types";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): MessagesTimelineRow[] {
  const messages: ChatMessage[] = entries.map(([role, text], index) => ({
    id: MessageId.make(`message-${index}`),
    role,
    text,
    streaming: false,
    runId: null,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  return messages.map((message) => ({
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }));
}

describe("timeline minimap previews", () => {
  it("previews the answer, not the wrap-up after it, from the last turn", () => {
    const source = rows([
      ["user", "Check it"],
      ["assistant", "LAUNCHED"],
      ["assistant", "Findings in full."],
      ["assistant", "I closed the browser."],
    ]).map((row, index) =>
      row.kind === "message" && index > 0
        ? {
            ...row,
            message: { ...row.message, runId: (index === 1 ? "turn-1" : "turn-2") as never },
            showAssistantMeta: true,
          }
        : row,
    );
    const [item] = deriveTimelineMinimapItems(source);
    expect(resolveTimelineMinimapPreview(item!)?.assistantText).toBe("Findings in full.");
  });
});
