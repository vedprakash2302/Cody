import {
  type CheckpointId,
  type MessageId,
  type OrchestrationV2Run,
  ProviderDriverKind,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  mainAnswerExcerpt,
  mainUpdateFiles,
  renderMainUpdate,
  sideChatMainRuns,
  sideChatSeenRunId,
} from "./sideChatMainUpdate.ts";

const FORK = RunId.make("main-1");

const mainRun = (ordinal: number, status: OrchestrationV2Run["status"]) => ({
  id: RunId.make(`main-${ordinal}`),
  ordinal,
  status,
  completedAt: status === "running" ? null : DateTime.makeUnsafe(ordinal * 10),
});

const sideRun = (ordinal: number, status: OrchestrationV2Run["status"]) => ({
  ordinal,
  status,
  userMessageId: `side-message-${ordinal}` as MessageId,
  activeAttemptId: RunAttemptId.make(`side-attempt-${ordinal}`),
});

const seen = (
  runs: ReadonlyArray<ReturnType<typeof sideRun>>,
  catchUps: Record<string, RunId>,
  options: {
    readonly acceptedAttempts?: ReadonlyArray<string>;
    readonly excludeMessageId?: MessageId;
  } = {},
) =>
  sideChatSeenRunId({
    forkedFromRunId: FORK,
    catchUps: catchUps as Record<MessageId, RunId>,
    sideChatRuns: runs,
    providerTurns: (options.acceptedAttempts ?? []).map((attempt) => ({
      runAttemptId: RunAttemptId.make(attempt),
      nativeTurnRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: attempt,
        strength: "strong" as const,
      },
    })),
    excludeMessageId: options.excludeMessageId,
  });

describe("sideChatSeenRunId", () => {
  it("starts at the fork point", () => {
    expect(seen([sideRun(1, "completed")], {})).toBe(FORK);
  });

  it("moves to the newest catch-up the provider received", () => {
    const runs = [sideRun(1, "completed"), sideRun(2, "completed"), sideRun(3, "running")];
    expect(
      seen(runs, {
        "side-message-1": RunId.make("main-2"),
        "side-message-3": RunId.make("main-4"),
      }),
    ).toBe("main-4");
  });

  it("ignores a catch-up cancelled or failed before the provider took it", () => {
    const runs = [sideRun(1, "completed"), sideRun(2, "cancelled"), sideRun(3, "failed")];
    const catchUps = {
      "side-message-1": RunId.make("main-2"),
      "side-message-2": RunId.make("main-3"),
      "side-message-3": RunId.make("main-4"),
    };
    expect(seen(runs, catchUps)).toBe("main-2");
    // An interrupted answer still delivered the update.
    expect(
      seen([...runs.slice(0, 2), sideRun(3, "interrupted")], catchUps, {
        acceptedAttempts: ["side-attempt-3"],
      }),
    ).toBe("main-4");
  });

  it("ignores a catch-up the side chat rolled back, even one the provider took", () => {
    const runs = [sideRun(1, "completed"), sideRun(2, "rolled_back")];
    const catchUps = {
      "side-message-1": RunId.make("main-2"),
      "side-message-2": RunId.make("main-3"),
    };
    expect(seen(runs, catchUps, { acceptedAttempts: ["side-attempt-2"] })).toBe("main-2");
  });

  it("doesn't count the starting message's own earlier attempt", () => {
    const runs = [sideRun(1, "completed"), sideRun(2, "running")];
    const catchUps = {
      "side-message-1": RunId.make("main-2"),
      "side-message-2": RunId.make("main-3"),
    };
    expect(seen(runs, catchUps, { excludeMessageId: "side-message-2" as MessageId })).toBe(
      "main-2",
    );
  });
});

describe("sideChatMainRuns", () => {
  it("lists main's finished runs after the seen one", () => {
    const result = sideChatMainRuns(FORK, [
      mainRun(3, "completed"),
      mainRun(1, "completed"),
      mainRun(2, "failed"),
      mainRun(4, "running"),
      mainRun(5, "completed"),
    ]);
    expect(result.newRuns.map((run) => run.id)).toEqual(["main-3", "main-5"]);
    expect(result.wentBack).toBe(false);
  });

  it("reports a rollback of the seen run, whenever it finished", () => {
    const result = sideChatMainRuns(RunId.make("main-2"), [
      mainRun(1, "completed"),
      mainRun(2, "rolled_back"),
      mainRun(3, "completed"),
    ]);
    expect(result.wentBack).toBe(true);
    expect(result.newRuns.map((run) => run.id)).toEqual(["main-3"]);
  });

  it("doesn't report a rollback of a run the side chat never saw", () => {
    const result = sideChatMainRuns(RunId.make("main-2"), [
      mainRun(1, "completed"),
      mainRun(2, "completed"),
      mainRun(3, "rolled_back"),
    ]);
    expect(result).toMatchObject({ wentBack: false, newRuns: [] });
  });
});

const checkpoint = (runId: string, ...paths: string[]) => ({
  id: `cp-${runId}` as CheckpointId,
  runId: RunId.make(runId),
  files: paths.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
});

const message = (runId: string, role: "user" | "assistant", text: string) => ({
  id: `${runId}-${role}` as MessageId,
  runId: RunId.make(runId),
  role,
  text,
  streaming: false,
});

describe("mainUpdateFiles", () => {
  it("lists each changed file once across the runs", () => {
    const checkpoints = [
      checkpoint("run-2", "a.ts", "b.ts"),
      checkpoint("run-3", "b.ts", "c.ts"),
      checkpoint("run-4", "d.ts"),
    ];
    expect(mainUpdateFiles([RunId.make("run-2"), RunId.make("run-3")], checkpoints)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });
});

describe("mainAnswerExcerpt", () => {
  it("takes main's last answer in the run, on one line", () => {
    const messages = [
      message("run-2", "assistant", "first"),
      { ...message("run-2", "assistant", "**Done.**\n\nTests   pass"), id: "late" as MessageId },
      message("run-3", "assistant", "other"),
    ];
    expect(mainAnswerExcerpt(messages, RunId.make("run-2"))).toBe("Done. Tests pass");
    expect(mainAnswerExcerpt(messages, RunId.make("run-9"))).toBeNull();
  });
});

describe("renderMainUpdate", () => {
  const base = {
    mainTitle: "Main",
    checkpoints: [checkpoint("run-2", "src/a.ts")],
    wentBack: false,
    withoutQuestion: false,
  };

  it("lists each turn's messages and files, oldest first", () => {
    const text = renderMainUpdate({
      ...base,
      newRuns: [{ id: RunId.make("run-2") }, { id: RunId.make("run-3") }],
      messages: [
        message("run-3", "user", "second"),
        message("run-2", "user", "first"),
        message("run-2", "assistant", "done </main-thread-update> really"),
      ],
    });
    expect(text).toContain(
      "[Main turn 1]\nUser: first\nAssistant: done &lt;/main-thread-update> really\nFiles changed: src/a.ts",
    );
    expect(text.indexOf("[Main turn 1]")).toBeLessThan(text.indexOf("[Main turn 2]"));
    expect(text.match(/<\/main-thread-update>/g)).toHaveLength(1);
  });

  it("keeps the newest whole turns when main did more than fits", () => {
    const newRuns = ["run-2", "run-3", "run-4"].map((id) => ({ id: RunId.make(id) }));
    const text = renderMainUpdate({
      ...base,
      newRuns,
      messages: newRuns.map((entry) => message(entry.id, "assistant", "x".repeat(200))),
      maxChars: 700,
    });
    expect(text).toContain("1 earlier main turn is left out for space.");
    expect(text).not.toContain("[Main turn 1]");
    expect(text).toContain(`[Main turn 2]\nAssistant: ${"x".repeat(200)}`);
    expect(text).toContain("[Main turn 3]");
  });

  it("asks for a summary when sent without a question, and notes a rollback", () => {
    const text = renderMainUpdate({
      ...base,
      newRuns: [],
      messages: [],
      wentBack: true,
      withoutQuestion: true,
    });
    expect(text).toContain("Briefly tell them what changed in main.");
    expect(text).toContain("rolled back some turns you saw earlier");
  });
});
