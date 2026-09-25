/**
 * Turns an OpenCode child session's messages into a subagent transcript for
 * the Agents panel. Pure, so the size limits are testable without a server.
 */
import type { Message, Part } from "@opencode-ai/sdk/v2";
import {
  RuntimeTaskId,
  type SubagentTranscript,
  type SubagentTranscriptEntry,
} from "@t3tools/contracts";

/** Newest messages kept per request. Callers ask for one more to detect a cut. */
export const TRANSCRIPT_MESSAGE_LIMIT = 200;
const TEXT_MAX_CHARS = 20_000;
const TOOL_TITLE_MAX_CHARS = 200;
const TOOL_INPUT_MAX_CHARS = 2_000;
const TOOL_OUTPUT_MAX_CHARS = 4_000;
/** Whole-reply bounds, so one long session cannot send megabytes over a tunnel. */
const TRANSCRIPT_MAX_ENTRIES = 400;
const TRANSCRIPT_MAX_CHARS = 256_000;

interface OpenCodeSessionMessage {
  readonly info: Pick<Message, "id" | "role">;
  readonly parts: ReadonlyArray<Part>;
}

function entrySize(entry: SubagentTranscriptEntry): number {
  return entry.kind === "tool"
    ? entry.tool.length +
        (entry.title?.length ?? 0) +
        (entry.input?.length ?? 0) +
        (entry.output?.length ?? 0)
    : entry.text.length;
}

/**
 * `messages` is OpenCode's newest-first window in ascending order, fetched
 * with a limit of `TRANSCRIPT_MESSAGE_LIMIT + 1`.
 */
export function toOpenCodeSubagentTranscript(
  taskId: string,
  messages: ReadonlyArray<OpenCodeSessionMessage>,
): SubagentTranscript {
  let truncated = messages.length > TRANSCRIPT_MESSAGE_LIMIT;
  const window = truncated ? messages.slice(-TRANSCRIPT_MESSAGE_LIMIT) : messages;
  const clip = (value: string, max: number): string => {
    if (value.length <= max) return value;
    truncated = true;
    return `${value.slice(0, max)}…`;
  };
  const toEntry = (
    message: OpenCodeSessionMessage,
    part: Part,
  ): SubagentTranscriptEntry | undefined => {
    if (part.type === "text" || part.type === "reasoning") {
      // Synthetic text is OpenCode's own scaffolding (inlined files, notices).
      if (part.type === "text" && part.synthetic === true) return undefined;
      const text = part.text.trim();
      if (text.length === 0) return undefined;
      return {
        kind:
          part.type === "reasoning"
            ? "reasoning"
            : message.info.role === "user"
              ? "prompt"
              : "text",
        id: part.id,
        text: clip(text, TEXT_MAX_CHARS),
      };
    }
    if (part.type !== "tool") return undefined;
    const { state } = part;
    const input =
      Object.keys(state.input ?? {}).length > 0
        ? clip(JSON.stringify(state.input, null, 2), TOOL_INPUT_MAX_CHARS)
        : undefined;
    const output =
      state.status === "completed"
        ? state.output
        : state.status === "error"
          ? state.error
          : undefined;
    const title =
      state.status === "running" || state.status === "completed" ? state.title : undefined;
    return {
      kind: "tool",
      id: part.id,
      tool: part.tool,
      ...(title ? { title: clip(title, TOOL_TITLE_MAX_CHARS) } : {}),
      status: state.status === "error" ? "failed" : state.status,
      ...(input ? { input } : {}),
      ...(output && output.trim().length > 0
        ? { output: clip(output.trim(), TOOL_OUTPUT_MAX_CHARS) }
        : {}),
    };
  };

  // The first entry is pinned when it is the task prompt.
  let prompt: SubagentTranscriptEntry | undefined;
  let promptAt: { readonly message: number; readonly part: number } | undefined;
  search: for (const [messageIndex, message] of window.entries()) {
    for (const [partIndex, part] of message.parts.entries()) {
      const entry = toEntry(message, part);
      if (entry === undefined) continue;
      if (entry.kind === "prompt") {
        prompt = entry;
        promptAt = { message: messageIndex, part: partIndex };
      }
      break search;
    }
  }

  // Then the newest entries that fit the budget. Walking newest-first stops
  // converting (and serializing tool input) once the budget is spent.
  let budget = TRANSCRIPT_MAX_CHARS - (prompt ? entrySize(prompt) : 0);
  let slots = TRANSCRIPT_MAX_ENTRIES - (prompt ? 1 : 0);
  const kept: SubagentTranscriptEntry[] = [];
  collect: for (let messageIndex = window.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = window[messageIndex]!;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      if (promptAt && messageIndex === promptAt.message && partIndex === promptAt.part) {
        break collect;
      }
      const entry = toEntry(message, message.parts[partIndex]!);
      if (entry === undefined) continue;
      const size = entrySize(entry);
      if (slots === 0 || size > budget) {
        truncated = true;
        break collect;
      }
      kept.push(entry);
      budget -= size;
      slots -= 1;
    }
  }
  kept.reverse();
  return {
    taskId: RuntimeTaskId.make(taskId),
    entries: prompt ? [prompt, ...kept] : kept,
    truncated,
  };
}
