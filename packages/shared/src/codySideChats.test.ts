import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2Run,
  ProviderDriverKind,
  RunAttemptId,
  RunId,
  type ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { carriedThroughRunId, linkedThreadChips, newerFinishedRuns } from "./codySideChats.ts";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "./composerContextReferences.ts";

const SOURCE = ThreadId.make("source");
const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);

const chip = (threadId: string): ThreadContextRecord => ({
  version: 1,
  kind: "thread",
  contextId: toKindScopedComposerContextId("thread", threadId),
  label: threadId,
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(threadId),
  title: threadId,
});

/** A source run finishing at `ordinal * 10` seconds. */
const sourceRun = (ordinal: number, status: OrchestrationV2Run["status"] = "completed") => ({
  id: RunId.make(`source-${ordinal}`),
  ordinal,
  status,
  completedAt: status === "running" ? null : at(ordinal * 10),
});
const sourceRuns = [1, 2, 3, 4].map((ordinal) => sourceRun(ordinal));

/** A carrier message starting its own run at `startedAt` seconds. */
const carrierTurn = (
  name: string,
  startedAt: number,
  status: OrchestrationV2Run["status"] = "completed",
  withChip = true,
) => ({
  message: {
    id: MessageId.make(`${name}-message`),
    runId: RunId.make(`${name}-run`),
    role: "user" as const,
    text: withChip ? `${formatComposerContextReference(chip("source"))} hi` : "hi",
    context: withChip ? { version: 1 as const, records: [chip("source")] } : undefined,
    createdAt: at(startedAt - 1),
  },
  run: {
    id: RunId.make(`${name}-run`),
    status,
    userMessageId: MessageId.make(`${name}-message`),
    activeAttemptId: RunAttemptId.make(`${name}-attempt`),
    startedAt: at(startedAt),
    requestedAt: at(startedAt - 1),
  },
});

const carried = (
  turns: ReadonlyArray<ReturnType<typeof carrierTurn>>,
  options: {
    readonly startRunId?: RunId | null;
    readonly accepted?: ReadonlyArray<string>;
    readonly exclude?: string;
  } = {},
) =>
  carriedThroughRunId({
    startRunId: options.startRunId === undefined ? RunId.make("source-1") : options.startRunId,
    sourceThreadId: SOURCE,
    sourceRuns,
    carrier: {
      messages: turns.map((turn) => turn.message),
      runs: turns.map((turn) => turn.run),
      providerTurns: (options.accepted ?? []).map((attempt) => ({
        runAttemptId: RunAttemptId.make(attempt),
        nativeTurnRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: attempt,
          strength: "strong" as const,
        },
      })),
    },
    excludeMessageId: options.exclude === undefined ? undefined : MessageId.make(options.exclude),
  });

describe("carriedThroughRunId", () => {
  it("starts at the given run, and with none has received nothing", () => {
    expect(carried([])).toBe("source-1");
    expect(carried([], { startRunId: null })).toBeNull();
  });

  it("moves to the newest source run finished when a chip-carrying turn started", () => {
    expect(carried([carrierTurn("a", 25), carrierTurn("b", 35, "running")])).toBe("source-3");
    // A turn without the chip moves nothing.
    expect(carried([carrierTurn("a", 45, "completed", false)])).toBe("source-1");
  });

  it("ignores a turn cancelled or failed before the provider took it", () => {
    expect(carried([carrierTurn("a", 25), carrierTurn("b", 45, "failed")])).toBe("source-2");
    // An interrupted answer still delivered the chip.
    expect(
      carried([carrierTurn("a", 25), carrierTurn("b", 45, "interrupted")], {
        accepted: ["b-attempt"],
      }),
    ).toBe("source-4");
  });

  it("ignores a rolled-back turn, even one the provider took", () => {
    expect(
      carried([carrierTurn("a", 25), carrierTurn("b", 45, "rolled_back")], {
        accepted: ["b-attempt"],
      }),
    ).toBe("source-2");
  });

  it("doesn't count the message being sent now", () => {
    expect(
      carried([carrierTurn("a", 25), carrierTurn("b", 45, "running")], { exclude: "b-message" }),
    ).toBe("source-2");
  });

  it("counts a message steered into another message's turn from when it was sent", () => {
    const host = carrierTurn("host", 5, "running", false);
    const steer = {
      ...carrierTurn("steer", 36).message,
      runId: host.run.id,
    };
    expect(
      carriedThroughRunId({
        startRunId: null,
        sourceThreadId: SOURCE,
        sourceRuns,
        carrier: { messages: [host.message, steer], runs: [host.run], providerTurns: [] },
      }),
    ).toBe("source-3");
  });
});

describe("newerFinishedRuns", () => {
  it("lists finished runs after the seen one, oldest first", () => {
    const result = newerFinishedRuns(RunId.make("source-1"), [
      sourceRun(3),
      sourceRun(1),
      sourceRun(2, "failed"),
      sourceRun(4, "running"),
      sourceRun(5),
    ]);
    expect(result.newRuns.map((run) => run.id)).toEqual(["source-3", "source-5"]);
    expect(result.wentBack).toBe(false);
  });

  it("reports a rollback of the seen run only", () => {
    expect(
      newerFinishedRuns(RunId.make("source-2"), [
        sourceRun(1),
        sourceRun(2, "rolled_back"),
        sourceRun(3),
      ]),
    ).toMatchObject({ wentBack: true, newRuns: [{ id: "source-3" }] });
    expect(
      newerFinishedRuns(RunId.make("source-2"), [
        sourceRun(1),
        sourceRun(2),
        sourceRun(3, "rolled_back"),
      ]),
    ).toMatchObject({ wentBack: false, newRuns: [] });
  });
});

describe("linkedThreadChips", () => {
  it("keeps only thread chips the text still links to", () => {
    const [linked, unlinked] = [chip("linked"), chip("unlinked")];
    expect(
      linkedThreadChips({
        text: `${formatComposerContextReference(linked)} question`,
        context: { version: 1, records: [linked, unlinked] },
      }),
    ).toEqual([linked]);
  });
});
