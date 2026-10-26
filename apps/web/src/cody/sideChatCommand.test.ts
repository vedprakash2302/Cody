import { describe, expect, it } from "vite-plus/test";

import { appendSideChatQuote, sideChatQuestionForSend } from "./sideChatCommand";

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
