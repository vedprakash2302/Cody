import { describe, expect, it } from "vite-plus/test";

import { sideChatQuestionForSend } from "./sideChatCommand";

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
