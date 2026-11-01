import { type CheckpointId, type MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { renderMainUpdate } from "./sideChatMainUpdate.ts";

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

describe("renderMainUpdate", () => {
  const base = {
    mainThreadId: ThreadId.make("main"),
    mainTitle: "Main",
    items: [],
    checkpoints: [checkpoint("run-2", "src/a.ts")],
    wentBack: false,
    withoutQuestion: false,
  };

  it("lists each turn's messages and changed files, oldest first", () => {
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
      "[Main turn 1]\nUser: first\nAssistant: done &lt;/main-thread-update> really\nChanged: src/a.ts",
    );
    expect(text.indexOf("[Main turn 1]")).toBeLessThan(text.indexOf("[Main turn 2]"));
    expect(text.match(/<\/main-thread-update>/g)).toHaveLength(1);
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
