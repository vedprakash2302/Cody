import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  CODY_NEW_SIDE_CHAT_TITLE,
  type MessageId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
} from "@t3tools/contracts";

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
    fallbackLabels: ["Catch up with the thread"],
  });
  return seed.length === 0 ? {} : { titleSeed: seed };
}

/** A side chat message that carried the thread's update, keyed like a dismissal. */
export interface SideChatSentUpdate {
  readonly key: string;
  readonly messageId: MessageId;
}

/**
 * Whether a sent message still carries the thread's update. Matches the
 * server, which counts it as seen once the provider takes the turn: a run that
 * ends before that, or is rolled back, no longer carries it.
 */
export function sentUpdatePending(
  sent: SideChatSentUpdate | undefined,
  key: string,
  projection: {
    readonly runs: ReadonlyArray<
      Pick<OrchestrationV2Run, "userMessageId" | "status" | "activeAttemptId">
    >;
    readonly providerTurns: ReadonlyArray<
      Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "nativeTurnRef">
    >;
  },
): boolean {
  if (sent === undefined || sent.key !== key) return false;
  const run = projection.runs.find((candidate) => candidate.userMessageId === sent.messageId);
  if (run === undefined) return true;
  switch (run.status) {
    case "rolled_back":
      return false;
    case "failed":
    case "cancelled":
    case "interrupted":
      return projection.providerTurns.some(
        (turn) => turn.runAttemptId === run.activeAttemptId && turn.nativeTurnRef !== null,
      );
    default:
      return true;
  }
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
