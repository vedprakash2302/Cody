import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { CODY_NEW_SIDE_CHAT_TITLE } from "@t3tools/contracts";

/**
 * Whether a first message names its thread. A side chat takes a name only
 * while it has none, so a name the user gave it stays.
 */
export const namesThreadOnSend = (thread: {
  readonly title: string;
  readonly source: { readonly codySideChat?: boolean | undefined };
}) => thread.source.codySideChat !== true || thread.title === CODY_NEW_SIDE_CHAT_TITLE;

/** The title seed for a side chat message: the server applies it only to a first message. */
export function sideChatTitleSeed(title: string, text: string): { readonly titleSeed?: string } {
  if (title !== CODY_NEW_SIDE_CHAT_TITLE) return {};
  const seed = deriveThreadTitleSeed({
    text: text.replace(/^>[ \t]?/gmu, ""),
    attachments: [],
    fallbackLabels: ["Catch up with main"],
  });
  return seed.length === 0 ? {} : { titleSeed: seed };
}

/**
 * `/side` alone starts a side chat; `/side <question>` also asks it. Returns
 * null for any other text.
 */
export function parseSideChatCommand(text: string): string | null {
  const match = /^\/side(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match === null ? null : (match[1] ?? "").trim();
}

/**
 * The side chat draft after quoting `selection` into it, ending on an empty
 * line for the question. The quote carries the text itself because the side
 * chat may have forked before the turn it came from.
 */
export function appendSideChatQuote(draft: string, selection: string): string {
  const quote = selection
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim().length === 0 ? ">" : `> ${line}`))
    .join("\n");
  if (quote === ">") return draft;
  const before = draft.trimEnd();
  return before.length === 0 ? `${quote}\n\n` : `${before}\n\n${quote}\n\n`;
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
