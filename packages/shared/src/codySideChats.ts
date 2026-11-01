import type {
  ComposerContextRecord,
  MessageId,
  OrchestrationMessageContext,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  RunId,
  ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { collectComposerContextReferences } from "./composerContextReferences.ts";

/**
 * Cody's side chat bookkeeping, derived from projection records so nothing is
 * stored: what a side chat has seen of its main thread, and what a thread has
 * received of a side chat brought back into it. The server builds turn text
 * from these and the web shows the same counts.
 */

/** The thread chips in a message whose text still links to them. */
export function linkedThreadChips(message: {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}): ReadonlyArray<ThreadContextRecord> {
  const records = message.context?.records ?? [];
  if (records.length === 0) return [];
  const linked = new Set(
    collectComposerContextReferences(message.text).map((ref) => ref.contextId),
  );
  return records.filter(
    (candidate: ComposerContextRecord): candidate is ThreadContextRecord =>
      candidate.kind === "thread" && "threadId" in candidate && linked.has(candidate.contextId),
  );
}

/** The chip for `threadId` that a message carries, if its text still links to it. */
export function linkedThreadChip(
  message: { readonly text: string; readonly context?: OrchestrationMessageContext | undefined },
  threadId: ThreadId,
): ThreadContextRecord | null {
  return linkedThreadChips(message).find((record) => record.threadId === threadId) ?? null;
}

type CarrierRun = Pick<
  OrchestrationV2Run,
  "id" | "status" | "userMessageId" | "activeAttemptId" | "startedAt" | "requestedAt"
>;
type CarrierMessage = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "runId" | "role" | "text" | "context" | "createdAt"
>;
type AcceptedTurn = Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "nativeTurnRef">;
export type CoveredRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "completedAt">;

const STARTED_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "running",
  "waiting",
  "completed",
]);

/**
 * When each message carrying `chipThreadId` delivered it. A message that
 * started its own run counts from that run's start once its provider took the
 * turn; one steered into a running turn counts from when it was sent. Neither
 * counts once its run is rolled back, which drops it from the provider.
 */
function chipDeliveries(input: {
  readonly chipThreadId: ThreadId;
  readonly messages: ReadonlyArray<CarrierMessage>;
  readonly runs: ReadonlyArray<CarrierRun>;
  readonly providerTurns: ReadonlyArray<AcceptedTurn>;
  readonly excludeMessageId?: MessageId | undefined;
}): ReadonlyArray<number> {
  const accepted = new Set(
    input.providerTurns.flatMap((turn) =>
      turn.nativeTurnRef !== null && turn.runAttemptId !== null ? [turn.runAttemptId] : [],
    ),
  );
  const runs = new Map(input.runs.map((run) => [run.id, run]));
  const deliveries: Array<number> = [];
  for (const message of input.messages) {
    if (message.role !== "user" || message.id === input.excludeMessageId) continue;
    if (linkedThreadChip(message, input.chipThreadId) === null) continue;
    const run = message.runId === null ? undefined : runs.get(message.runId);
    if (run === undefined || run.status === "rolled_back") continue;
    if (run.userMessageId !== message.id) {
      deliveries.push(DateTime.toEpochMillis(message.createdAt));
      continue;
    }
    const taken =
      STARTED_STATUSES.has(run.status) ||
      (run.activeAttemptId !== null && accepted.has(run.activeAttemptId));
    if (taken) deliveries.push(DateTime.toEpochMillis(run.startedAt ?? run.requestedAt));
  }
  return deliveries;
}

/** The newest run that finished by `time`, including one since rolled back. */
function newestFinishedBy(runs: ReadonlyArray<CoveredRun>, time: number): CoveredRun | null {
  let newest: CoveredRun | null = null;
  for (const run of runs) {
    if (run.completedAt === null || (run.status !== "completed" && run.status !== "rolled_back"))
      continue;
    if (DateTime.toEpochMillis(run.completedAt) > time) continue;
    if (newest === null || run.ordinal > newest.ordinal) newest = run;
  }
  return newest;
}

/**
 * The newest run of `sourceRuns` the carrier thread has received: the given
 * starting point, or what its messages carrying the source thread's chip covered.
 */
export function carriedThroughRunId(input: {
  readonly startRunId: RunId | null;
  readonly sourceThreadId: ThreadId;
  readonly sourceRuns: ReadonlyArray<CoveredRun>;
  readonly carrier: {
    readonly messages: ReadonlyArray<CarrierMessage>;
    readonly runs: ReadonlyArray<CarrierRun>;
    readonly providerTurns: ReadonlyArray<AcceptedTurn>;
  };
  /** The message being sent now, which can't count as received yet. */
  readonly excludeMessageId?: MessageId | undefined;
}): RunId | null {
  let newest = input.sourceRuns.find((run) => run.id === input.startRunId) ?? null;
  for (const time of chipDeliveries({
    chipThreadId: input.sourceThreadId,
    ...input.carrier,
    excludeMessageId: input.excludeMessageId,
  })) {
    const covered = newestFinishedBy(input.sourceRuns, time);
    if (covered !== null && (newest === null || covered.ordinal > newest.ordinal)) {
      newest = covered;
    }
  }
  return newest?.id ?? input.startRunId;
}

export interface NewerRuns<Run extends CoveredRun> {
  readonly seen: Run | null;
  /** Finished runs since the seen one, oldest first. */
  readonly newRuns: ReadonlyArray<Run>;
  /** The seen run was rolled back since. */
  readonly wentBack: boolean;
}

export function newerFinishedRuns<Run extends CoveredRun>(
  seenRunId: RunId | null,
  runs: ReadonlyArray<Run>,
): NewerRuns<Run> {
  const seen = runs.find((run) => run.id === seenRunId) ?? null;
  const newRuns = [...runs]
    .sort((left, right) => left.ordinal - right.ordinal)
    .filter(
      (run) =>
        run.status === "completed" &&
        run.completedAt !== null &&
        (seen === null || run.ordinal > seen.ordinal),
    );
  return { seen, newRuns, wentBack: seen?.status === "rolled_back" };
}
