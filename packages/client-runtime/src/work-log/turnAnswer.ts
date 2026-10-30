// A settled turn folds to its last assistant message, which can be a one-line
// wrap-up after cleanup that hides the real answer. This finds that answer. It
// looks one step back only, so commentary between tool calls stays folded.

/** Longest last message that still reads as a wrap-up rather than an answer. */
const WRAP_UP_MAX_CHARS = 280;
/** Most tool calls a wrap-up may follow its answer by. */
const WRAP_UP_MAX_TOOL_CALLS = 3;

export type TurnSequenceItem =
  | { readonly kind: "assistant"; readonly id: string; readonly text: string }
  | { readonly kind: "reasoning" }
  | { readonly kind: "work"; readonly toolCalls: number }
  /** Subagent launches and task rows: real work the answer cannot sit behind. */
  | { readonly kind: "boundary" };

interface WorkEntryShape {
  readonly sourceActivityKind?: string | undefined;
  readonly itemType?: string | undefined;
  readonly agentSpawn?: unknown;
}

/**
 * How one work-log entry counts toward the wrap-up budget. Tool lifecycle rows
 * are calls. Subagent work is a boundary. Bookkeeping such as compaction,
 * warnings, plan updates, and answered questions is not work at all.
 */
export function classifyWorkEntry(entry: WorkEntryShape): TurnSequenceItem | null {
  if (
    entry.agentSpawn !== undefined ||
    entry.itemType === "collab_agent_tool_call" ||
    entry.itemType === "subagent" ||
    entry.sourceActivityKind?.startsWith("task.") === true
  ) {
    return { kind: "boundary" };
  }
  if (entry.itemType === "reasoning") return { kind: "reasoning" };
  return entry.sourceActivityKind?.startsWith("tool.") === true ||
    [
      "command_execution",
      "file_change",
      "dynamic_tool",
      "file_read",
      "file_search",
      "web_search",
    ].includes(entry.itemType ?? "")
    ? { kind: "work", toolCalls: 1 }
    : null;
}

/**
 * The id of the answer a trailing wrap-up follows, or null. `items` is one
 * turn's entries in display order.
 */
export function findAnswerBeforeWrapUp(items: ReadonlyArray<TurnSequenceItem>): string | null {
  // A loop, not findLastIndex: mobile runs on Hermes, which lacks ES2023 array methods.
  let wrapUpIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.kind === "assistant") {
      wrapUpIndex = index;
      break;
    }
  }
  const wrapUp = items[wrapUpIndex];
  if (wrapUp?.kind !== "assistant" || wrapUp.text.trim().length > WRAP_UP_MAX_CHARS) {
    return null;
  }
  let toolCalls = 0;
  for (let index = wrapUpIndex - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "reasoning") continue;
    if (item.kind === "boundary") return null;
    if (item.kind === "work") {
      toolCalls += item.toolCalls;
      if (toolCalls > WRAP_UP_MAX_TOOL_CALLS) return null;
      continue;
    }
    return item.text.trim().length > WRAP_UP_MAX_CHARS ? item.id : null;
  }
  return null;
}
