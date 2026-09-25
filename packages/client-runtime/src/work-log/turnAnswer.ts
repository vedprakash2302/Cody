/**
 * Clients fold a settled turn down to its last assistant message. Agents often
 * finish cleanup after answering ("I've closed the browser."), so that last
 * message can be a one-line wrap-up that hides the real answer written just
 * before it. This finds that answer so it stays visible.
 *
 * It looks one step back only. Commentary between tool calls ("Let me check
 * X") must stay folded, and a chain across every small tool gap would surface
 * all of it.
 */

/** Longest last message that still reads as a wrap-up rather than an answer. */
export const WRAP_UP_MAX_CHARS = 280;
/** Most tool calls a wrap-up may follow its answer by. */
export const WRAP_UP_MAX_TOOL_CALLS = 3;

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
    entry.sourceActivityKind?.startsWith("task.") === true
  ) {
    return { kind: "boundary" };
  }
  return entry.sourceActivityKind?.startsWith("tool.") === true
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
