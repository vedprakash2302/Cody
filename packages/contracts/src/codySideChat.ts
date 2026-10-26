import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, RunId, ThreadId } from "./baseSchemas.ts";

/**
 * Cody's side chats: a fork of a thread that opens beside it instead of in the
 * thread list. These RPCs exist only on Cody servers, which advertise
 * `codySideChat`; clients hide every side-chat entry point without it.
 */
export const CODY_SIDE_CHAT_WS_METHODS = {
  open: "cody.sideChat.open",
  close: "cody.sideChat.close",
  promote: "cody.sideChat.promote",
  mainView: "cody.sideChat.mainView",
} as const;

/**
 * A Cody server sends side chats only to clients that ask for them with this
 * query parameter, on the WebSocket URL and on the shell snapshot request, and
 * marks them with `codySideChat` on the thread shell. Official clients never
 * send it, so side chats stay out of their lists.
 */
export const CODY_CLIENT_FEATURES_PARAM = "codyFeatures";
export const CODY_SIDE_CHAT_CLIENT_FEATURE = "sideChat";

export function readCodyClientFeatures(value: string | null | undefined): {
  readonly sideChats: boolean;
} {
  const features = (value ?? "").split(",").map((feature) => feature.trim());
  return { sideChats: features.includes(CODY_SIDE_CHAT_CLIENT_FEATURE) };
}

export const CodySideChatOpenInput = Schema.Struct({
  parentThreadId: ThreadId,
  creationSource: Schema.optionalKey(Schema.Literals(["web", "mobile"])),
  /** Close the parent's open side chat and start a new one from its latest response. */
  fresh: Schema.optionalKey(Schema.Boolean),
  /** Reopen this closed side chat of the parent, closing any other open one. */
  reopenThreadId: Schema.optionalKey(ThreadId),
});
export type CodySideChatOpenInput = typeof CodySideChatOpenInput.Type;

export const CodySideChatOpenResult = Schema.Struct({
  threadId: ThreadId,
  /** False when the parent already had an open side chat, which is returned instead. */
  created: Schema.Boolean,
});
export type CodySideChatOpenResult = typeof CodySideChatOpenResult.Type;

export const CodySideChatThreadInput = Schema.Struct({ threadId: ThreadId });
export type CodySideChatThreadInput = typeof CodySideChatThreadInput.Type;

export const CodySideChatCloseResult = Schema.Struct({
  /** A side chat closed before its first message is deleted rather than archived. */
  outcome: Schema.Literals(["archived", "deleted"]),
});
export type CodySideChatCloseResult = typeof CodySideChatCloseResult.Type;

/** What a side chat has seen of its parent, and what the parent finished since. */
export const CodySideChatMainView = Schema.Struct({
  /** The newest parent run the side chat has seen, through its fork or a catch-up. */
  seenRunId: Schema.NullOr(RunId),
  /** The start of the parent's answer in that run. */
  seenExcerpt: Schema.NullOr(Schema.String),
  /** The parent's finished runs since then, oldest first. */
  newRunIds: Schema.Array(RunId),
  filesChanged: NonNegativeInt,
  /** The parent rolled back the run the side chat last saw. */
  wentBack: Schema.Boolean,
});
export type CodySideChatMainView = typeof CodySideChatMainView.Type;

export class CodySideChatError extends Schema.TaggedError<CodySideChatError>()(
  "CodySideChatError",
  {
    threadId: ThreadId,
    reason: Schema.Literals([
      "thread-not-found",
      "not-a-side-chat",
      "nested-side-chat",
      "no-finished-response",
      "provider-unsupported",
      "store-failed",
      "dispatch-failed",
      "read-failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "thread-not-found":
        return "This thread no longer exists.";
      case "not-a-side-chat":
        return "This thread is not a side chat.";
      case "nested-side-chat":
        return "A side chat cannot open its own side chat.";
      case "no-finished-response":
        return "Side chats are available after the first response finishes.";
      case "provider-unsupported":
        return "This provider cannot share a thread's history with a side chat.";
      case "store-failed":
        return "Failed to save the side chat list.";
      case "dispatch-failed":
        return "Failed to update the side chat.";
      case "read-failed":
        return "Failed to read the side chat.";
    }
  }
}

export const CodySideChatOpenRpc = Rpc.make(CODY_SIDE_CHAT_WS_METHODS.open, {
  payload: CodySideChatOpenInput,
  success: CodySideChatOpenResult,
  error: Schema.Union([CodySideChatError, EnvironmentAuthorizationError]),
});

export const CodySideChatCloseRpc = Rpc.make(CODY_SIDE_CHAT_WS_METHODS.close, {
  payload: CodySideChatThreadInput,
  success: CodySideChatCloseResult,
  error: Schema.Union([CodySideChatError, EnvironmentAuthorizationError]),
});

export const CodySideChatMainViewRpc = Rpc.make(CODY_SIDE_CHAT_WS_METHODS.mainView, {
  payload: CodySideChatThreadInput,
  success: CodySideChatMainView,
  error: Schema.Union([CodySideChatError, EnvironmentAuthorizationError]),
});

export const CodySideChatPromoteRpc = Rpc.make(CODY_SIDE_CHAT_WS_METHODS.promote, {
  payload: CodySideChatThreadInput,
  success: Schema.Void,
  error: Schema.Union([CodySideChatError, EnvironmentAuthorizationError]),
});
