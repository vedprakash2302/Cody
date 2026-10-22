/**
 * `/side` alone opens the side chat; `/side <question>` also asks it. Returns
 * null for any other text.
 */
export function parseSideChatCommand(text: string): string | null {
  const match = /^\/side(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match === null ? null : (match[1] ?? "").trim();
}

/**
 * The side chat question a composer send carries instead of a turn, or null
 * when the send goes to the thread. Attachments, contexts, and preview
 * annotations always go to the thread.
 */
export function sideChatQuestionForSend(input: {
  readonly sideChatsEnabled: boolean;
  readonly directAnnotation: boolean;
  readonly hasNonPromptContent: boolean;
  readonly prompt: string;
}): string | null {
  if (!input.sideChatsEnabled || input.directAnnotation || input.hasNonPromptContent) return null;
  return parseSideChatCommand(input.prompt);
}
