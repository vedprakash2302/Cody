/**
 * One subagent's transcript, read on demand from the provider's own storage
 * when a user opens an agent in the Agents panel. Nothing here is persisted
 * or streamed: a transcript can be large, and the thread's event log only
 * carries each subagent's status.
 */
import * as Schema from "effect/Schema";

import { RuntimeTaskId, ThreadId } from "./baseSchemas.ts";

export const SubagentTranscriptInput = Schema.Struct({
  threadId: ThreadId,
  /** The subagent's task id, as carried on its task.* activities. */
  taskId: RuntimeTaskId,
});
export type SubagentTranscriptInput = typeof SubagentTranscriptInput.Type;

const SubagentTranscriptTextEntry = Schema.Struct({
  kind: Schema.Literals(["prompt", "text", "reasoning"]),
  id: Schema.String,
  text: Schema.String,
});

const SubagentTranscriptToolEntry = Schema.Struct({
  kind: Schema.Literal("tool"),
  id: Schema.String,
  tool: Schema.String,
  title: Schema.optional(Schema.String),
  status: Schema.Literals(["pending", "running", "completed", "failed"]),
  /** Tool input and output are trimmed for display; see `truncated`. */
  input: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
});

export const SubagentTranscriptEntry = Schema.Union([
  SubagentTranscriptTextEntry,
  SubagentTranscriptToolEntry,
]);
export type SubagentTranscriptEntry = typeof SubagentTranscriptEntry.Type;

export const SubagentTranscript = Schema.Struct({
  taskId: RuntimeTaskId,
  entries: Schema.Array(SubagentTranscriptEntry),
  /** True when older entries or long text were cut to keep the reply small. */
  truncated: Schema.Boolean,
});
export type SubagentTranscript = typeof SubagentTranscript.Type;

const SUBAGENT_TRANSCRIPT_ERROR_MESSAGES = {
  unsupported: "This provider does not expose subagent transcripts.",
  "not-found": "This subagent's transcript is no longer available.",
  "session-inactive":
    "Transcripts load while this thread's session is running. Send a message to resume it.",
  unavailable: "Could not load the transcript.",
} as const;

export class SubagentTranscriptError extends Schema.TaggedError<SubagentTranscriptError>()(
  "SubagentTranscriptError",
  {
    reason: Schema.Literals(["unsupported", "not-found", "session-inactive", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return SUBAGENT_TRANSCRIPT_ERROR_MESSAGES[this.reason];
  }
}
