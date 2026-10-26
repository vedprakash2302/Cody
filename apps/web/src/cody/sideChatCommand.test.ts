import {
  MessageId,
  type OrchestrationV2RunStatus,
  ProviderDriverKind,
  RunAttemptId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendSideChatQuote,
  namesThreadOnSend,
  sentUpdatePending,
  sideChatQuestionForSend,
  sideChatTitleSeed,
} from "./sideChatCommand";

describe("side chat names", () => {
  it("lets a first message name a thread, or a side chat that has no name yet", () => {
    expect(namesThreadOnSend({ title: "New thread", source: {} })).toBe(true);
    expect(namesThreadOnSend({ title: "New side chat", source: { codySideChat: true } })).toBe(
      true,
    );
    expect(namesThreadOnSend({ title: "Retry logic", source: { codySideChat: true } })).toBe(false);
  });

  it("seeds an unnamed side chat from its message without the quote markers", () => {
    expect(sideChatTitleSeed("New side chat", "> flaky\n\nwhy?")).toEqual({
      titleSeed: "flaky why?",
    });
    expect(sideChatTitleSeed("New side chat", "")).toEqual({
      titleSeed: "Catch up with the thread",
    });
    expect(sideChatTitleSeed("Retry logic", "why?")).toEqual({});
  });
});

describe("appendSideChatQuote", () => {
  it("quotes every line and leaves an empty line for the question", () => {
    expect(appendSideChatQuote("", "  first line\n\nsecond line\n")).toBe(
      "> first line\n>\n> second line\n\n",
    );
  });

  it("adds each new quote after what the draft already holds", () => {
    const first = appendSideChatQuote("", "one");
    expect(appendSideChatQuote(first, "two")).toBe("> one\n\n> two\n\n");
    expect(appendSideChatQuote("why does\n", "three")).toBe("why does\n\n> three\n\n");
  });

  it("keeps the draft when the selection is only whitespace", () => {
    expect(appendSideChatQuote("draft", " \n ")).toBe("draft");
  });
});

const send = {
  sideChatsEnabled: true,
  directAnnotation: false,
  hasNonPromptContent: false,
  prompt: "/side",
};

describe("sideChatQuestionForSend", () => {
  it("opens the side chat for /side and asks it the rest", () => {
    expect(sideChatQuestionForSend(send)).toBe("");
    expect(sideChatQuestionForSend({ ...send, prompt: "  /SIDE what changed?\nand why " })).toBe(
      "what changed?\nand why",
    );
  });

  it("leaves every other send to the thread", () => {
    expect(sideChatQuestionForSend({ ...send, prompt: "/sidebar" })).toBeNull();
    expect(sideChatQuestionForSend({ ...send, prompt: "please /side" })).toBeNull();
    expect(sideChatQuestionForSend({ ...send, sideChatsEnabled: false })).toBeNull();
    expect(sideChatQuestionForSend({ ...send, directAnnotation: true })).toBeNull();
    expect(sideChatQuestionForSend({ ...send, hasNonPromptContent: true })).toBeNull();
  });
});

describe("sentUpdatePending", () => {
  const messageId = MessageId.make("message-1");
  const sent = { key: "run-2", messageId };
  const attemptId = RunAttemptId.make("attempt-1");
  const projection = (status: OrchestrationV2RunStatus, accepted = false) => ({
    runs: [{ userMessageId: messageId, status, activeAttemptId: attemptId }],
    providerTurns: accepted
      ? [
          {
            runAttemptId: attemptId,
            nativeTurnRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "native-1",
              strength: "strong" as const,
            },
          },
        ]
      : [],
  });

  it("keeps the update with a message the provider takes", () => {
    expect(sentUpdatePending(sent, "run-2", { runs: [], providerTurns: [] })).toBe(true);
    expect(sentUpdatePending(sent, "run-2", projection("queued"))).toBe(true);
    expect(sentUpdatePending(sent, "run-2", projection("running"))).toBe(true);
    expect(sentUpdatePending(sent, "run-2", projection("completed"))).toBe(true);
    expect(sentUpdatePending(sent, "run-2", projection("failed", true))).toBe(true);
  });

  it("gives the update back when the run ends before the provider takes it", () => {
    expect(sentUpdatePending(sent, "run-2", projection("failed"))).toBe(false);
    expect(sentUpdatePending(sent, "run-2", projection("cancelled"))).toBe(false);
    expect(sentUpdatePending(sent, "run-2", projection("rolled_back", true))).toBe(false);
  });

  it("lets a newer thread response attach again", () => {
    expect(sentUpdatePending(sent, "run-3", projection("running"))).toBe(false);
    expect(sentUpdatePending(undefined, "run-2", projection("running"))).toBe(false);
  });
});
