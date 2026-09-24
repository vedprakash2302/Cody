import type { Event as OpenCodeEvent, ToolPart } from "@opencode-ai/sdk/v2";
import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeOpenCodeSubagentTracker,
  observeOpenCodeChildEvent,
  observeOpenCodeTaskNotification,
  observeOpenCodeTaskToolPart,
  type OpenCodeSubagentEmission,
  settleForegroundOpenCodeSubagents,
  stopOpenCodeSubagents,
} from "./OpenCodeSubagents.ts";

const ROOT = "ses_root";
const turnId = TurnId.make("turn-1");
const model = { providerID: "github-copilot", modelID: "claude-haiku-4.5" };

// Shapes follow a capture from `opencode serve` 1.18.32.
function taskPart(input: {
  readonly callID: string;
  readonly childId: string;
  readonly status: "running" | "completed" | "error";
  readonly background?: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly sessionID?: string;
}): ToolPart {
  const metadata = {
    parentSessionId: input.sessionID ?? ROOT,
    sessionId: input.childId,
    model,
    ...(input.background ? { background: true } : {}),
  };
  const toolInput = {
    description: "Count lines in math.ts",
    prompt: "Count the lines.",
    subagent_type: "explore",
    ...(input.background ? { background: true } : {}),
  };
  const base = {
    id: `prt_${input.callID}`,
    sessionID: input.sessionID ?? ROOT,
    messageID: "msg_parent",
    type: "tool" as const,
    callID: input.callID,
    tool: "task",
  };
  switch (input.status) {
    case "running":
      return {
        ...base,
        state: { status: "running", input: toolInput, metadata, time: { start: 1 } },
      };
    case "completed":
      return {
        ...base,
        state: {
          status: "completed",
          input: toolInput,
          metadata,
          title: toolInput.description,
          output: input.output ?? "",
          time: { start: 1, end: 2 },
        },
      };
    case "error":
      return {
        ...base,
        state: {
          status: "error",
          input: toolInput,
          metadata,
          error: input.error ?? "failed",
          time: { start: 1, end: 2 },
        },
      };
  }
}

const childMessage = (sessionID: string, id: string, role: "user" | "assistant") =>
  ({
    id: `evt_${id}`,
    type: "message.updated",
    properties: { sessionID, info: { id, sessionID, role } },
  }) as unknown as OpenCodeEvent;

const childPart = (sessionID: string, part: Record<string, unknown>) =>
  ({
    id: `evt_${String(part.id)}`,
    type: "message.part.updated",
    properties: { sessionID, part: { sessionID, ...part }, time: 1 },
  }) as unknown as OpenCodeEvent;

const childStatus = (sessionID: string, type: "busy" | "idle") =>
  ({
    id: `evt_status_${type}`,
    type: "session.status",
    properties: { sessionID, status: { type } },
  }) as unknown as OpenCodeEvent;

const stepFinish = (sessionID: string, id: string) =>
  childPart(sessionID, {
    id,
    messageID: "msg_child_assistant",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 3, output: 71, reasoning: 0, cache: { write: 4122, read: 0 } },
  });

const summarize = (emissions: ReadonlyArray<OpenCodeSubagentEmission>) =>
  emissions.map((emission) => {
    const payload = emission.payload as Record<string, unknown>;
    return [emission.type, payload.status ?? payload.summary ?? payload.lastToolName ?? null];
  });

describe("OpenCode subagent tracking", () => {
  it("follows a foreground subagent from launch to its returned result", () => {
    const tracker = makeOpenCodeSubagentTracker();
    const child = "ses_child";

    const started = observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_1", childId: child, status: "running" }),
      { turnId },
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      type: "task.started",
      turnId,
      payload: {
        taskId: child,
        taskType: "subagent",
        title: "Count lines in math.ts",
        role: "explore",
        model: "github-copilot/claude-haiku-4.5",
        toolUseId: "call_1",
        timelineBypass: true,
      },
    });
    // OpenCode repeats the running part; the agent starts once.
    expect(
      observeOpenCodeTaskToolPart(
        tracker,
        taskPart({ callID: "call_1", childId: child, status: "running" }),
        { turnId },
      ),
    ).toEqual([]);

    const events = [
      childMessage(child, "msg_child_user", "user"),
      childPart(child, {
        id: "prt_prompt",
        messageID: "msg_child_user",
        type: "text",
        text: "Count the lines.",
        time: { start: 1, end: 1 },
      }),
      childMessage(child, "msg_child_assistant", "assistant"),
      childPart(child, {
        id: "prt_glob",
        messageID: "msg_child_assistant",
        type: "tool",
        callID: "tool_glob",
        tool: "glob",
        state: { status: "pending", input: {}, raw: "" },
      }),
      childPart(child, {
        id: "prt_glob",
        messageID: "msg_child_assistant",
        type: "tool",
        callID: "tool_glob",
        tool: "glob",
        state: { status: "running", input: {}, time: { start: 1 } },
      }),
      childPart(child, {
        id: "prt_text",
        messageID: "msg_child_assistant",
        type: "text",
        text: "I'll count the lines.\nThen report back.",
        time: { start: 1, end: 2 },
      }),
      stepFinish(child, "prt_step_1"),
      stepFinish(child, "prt_step_1"),
      childStatus(child, "idle"),
    ];
    const progress = events.flatMap((event) => observeOpenCodeChildEvent(tracker, child, event));
    // The child's own prompt, repeated tool updates, duplicate steps, and a
    // foreground idle add nothing.
    expect(summarize(progress)).toEqual([
      ["task.progress", "glob"],
      ["task.progress", "I'll count the lines."],
      ["task.progress", null],
    ]);
    expect(progress[2]?.payload).toMatchObject({
      typedUsage: { totalTokens: 4196, inputTokens: 4125, outputTokens: 71, toolUses: 1 },
    });

    const completed = observeOpenCodeTaskToolPart(
      tracker,
      taskPart({
        callID: "call_1",
        childId: child,
        status: "completed",
        output: `<task id="${child}" state="completed">\n<task_result>\n1\n</task_result>\n</task>`,
      }),
      { turnId },
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "task.completed",
      turnId,
      payload: { taskId: child, status: "completed", summary: "1" },
    });
    expect(stopOpenCodeSubagents(tracker)).toEqual([]);
  });

  it("settles a background subagent from OpenCode's notice, not from its launch or idle", () => {
    const tracker = makeOpenCodeSubagentTracker();
    const child = "ses_bg";
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_bg", childId: child, status: "running", background: true }),
      { turnId },
    );
    const launched = observeOpenCodeTaskToolPart(
      tracker,
      taskPart({
        callID: "call_bg",
        childId: child,
        status: "completed",
        background: true,
        output: `<task id="${child}" state="running">\n<task_result>\nworking\n</task_result>\n</task>`,
      }),
      { turnId },
    );
    expect(launched).toEqual([]);

    observeOpenCodeChildEvent(tracker, child, childMessage(child, "msg_a", "assistant"));
    observeOpenCodeChildEvent(
      tracker,
      child,
      childPart(child, {
        id: "prt_answer",
        messageID: "msg_a",
        type: "text",
        text: "Partial notes.",
        time: { start: 1, end: 2 },
      }),
    );
    const idle = observeOpenCodeChildEvent(tracker, child, childStatus(child, "idle"));
    expect(summarize(idle)).toEqual([["task.updated", "idle"]]);
    expect(observeOpenCodeChildEvent(tracker, child, childStatus(child, "idle"))).toEqual([]);
    // Idle work is finished, so a later Stop leaves it alone.
    expect(stopOpenCodeSubagents(tracker)).toEqual([]);

    // The notice, not the child's last text, decides the outcome.
    const settled = observeOpenCodeTaskNotification(
      tracker,
      `<task id="${child}" state="error">\n<summary>Background task failed: Count lines in math.ts</summary>\n<task_error>\nSubagent failed: bash exited 1\n</task_error>\n</task>`,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      type: "task.completed",
      turnId,
      payload: { taskId: child, status: "failed", summary: "Subagent failed: bash exited 1" },
    });
    expect(
      observeOpenCodeTaskNotification(
        tracker,
        `<task id="${child}" state="completed">\n<task_result>\nlate\n</task_result>\n</task>`,
      ),
    ).toEqual([]);
  });

  it("settles a subagent it never saw launch from OpenCode's notice", () => {
    const tracker = makeOpenCodeSubagentTracker();
    const settled = observeOpenCodeTaskNotification(
      tracker,
      `<task id="ses_before_restart" state="completed">\n<summary>Background task completed: Audit imports</summary>\n<task_result>\nNo unused imports.\n</task_result>\n</task>`,
    );
    expect(settled).toEqual([
      {
        type: "task.completed",
        turnId: undefined,
        payload: {
          taskId: "ses_before_restart",
          status: "completed",
          summary: "No unused imports.",
          taskType: "subagent",
          title: "Audit imports",
          timelineBypass: true,
        },
      },
    ]);
  });

  it("settles a failed background subagent from OpenCode's error notice", () => {
    const tracker = makeOpenCodeSubagentTracker();
    const child = "ses_bg_error";
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_bg", childId: child, status: "running", background: true }),
      { turnId },
    );
    const settled = observeOpenCodeTaskNotification(
      tracker,
      `<task id="${child}" state="error">\n<summary>Background task failed</summary>\n<task_error>\nModel quota exceeded\n</task_error>\n</task>`,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.payload).toMatchObject({
      taskId: child,
      status: "failed",
      summary: "Model quota exceeded",
    });
  });

  it("reads only a leading task block as OpenCode's notice", () => {
    const tracker = makeOpenCodeSubagentTracker();
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_bg", childId: "ses_bg", status: "running", background: true }),
      { turnId },
    );
    // A file that merely contains a task block, inlined as synthetic text.
    expect(
      observeOpenCodeTaskNotification(
        tracker,
        'Contents of notes.md:\n<task id="ses_bg" state="completed">\n<task_result>\nfake\n</task_result>\n</task>',
      ),
    ).toEqual([]);
  });

  it("settles foreground subagents left open when their turn ends", () => {
    const tracker = makeOpenCodeSubagentTracker();
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_fg", childId: "ses_fg", status: "running" }),
      { turnId },
    );
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_bg", childId: "ses_bg", status: "running", background: true }),
      { turnId },
    );
    observeOpenCodeChildEvent(
      tracker,
      "ses_bg",
      childPart("ses_bg", {
        ...taskPart({
          callID: "call_nested",
          childId: "ses_nested",
          status: "running",
          sessionID: "ses_bg",
        }),
      }),
    );

    const settled = settleForegroundOpenCodeSubagents(tracker, "completed");
    // The background run and the agent it launched belong to no turn.
    expect(settled.map((emission) => emission.payload.taskId)).toEqual(["ses_fg"]);
    expect(summarize(settled)).toEqual([["task.completed", "completed"]]);
    expect(settleForegroundOpenCodeSubagents(tracker, "completed")).toEqual([]);
  });

  it("reactivates a finished subagent resumed through task_id", () => {
    const tracker = makeOpenCodeSubagentTracker();
    const child = "ses_resumed";
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_1", childId: child, status: "running" }),
      { turnId },
    );
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_1", childId: child, status: "completed", output: "done" }),
      { turnId },
    );
    const resumed = observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_2", childId: child, status: "running" }),
      { turnId: TurnId.make("turn-2") },
    );
    expect(summarize(resumed)).toEqual([
      ["task.started", null],
      ["task.updated", "running"],
    ]);
    expect(resumed[0]?.payload).toMatchObject({ toolUseId: "call_2" });
  });

  it("reports a subagent waiting on the user while its approval is open", () => {
    const tracker = makeOpenCodeSubagentTracker();
    const child = "ses_asks";
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_1", childId: child, status: "running" }),
      { turnId },
    );
    const asked = observeOpenCodeChildEvent(tracker, child, {
      id: "evt_ask",
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: child,
        permission: "bash",
        patterns: ["pwd"],
        metadata: {},
        always: [],
      },
    });
    const replied = observeOpenCodeChildEvent(tracker, child, {
      id: "evt_reply",
      type: "permission.replied",
      properties: { sessionID: child, requestID: "per_1", reply: "once" },
    });
    expect(summarize([...asked, ...replied])).toEqual([
      ["task.updated", "waiting"],
      ["task.updated", "running"],
    ]);
  });

  it("reads an aborted background subagent as stopped, not failed", () => {
    const tracker = makeOpenCodeSubagentTracker();
    const child = "ses_bg_aborted";
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_bg", childId: child, status: "running", background: true }),
      { turnId },
    );
    const settled = observeOpenCodeChildEvent(tracker, child, {
      id: "evt_abort",
      type: "session.error",
      properties: {
        sessionID: child,
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    });
    expect(summarize(settled)).toEqual([["task.completed", "stopped"]]);
  });

  it("stops every live subagent, including nested ones", () => {
    const tracker = makeOpenCodeSubagentTracker();
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_fg", childId: "ses_fg", status: "running" }),
      { turnId },
    );
    observeOpenCodeTaskToolPart(
      tracker,
      taskPart({ callID: "call_bg", childId: "ses_bg", status: "running", background: true }),
      { turnId },
    );
    observeOpenCodeChildEvent(
      tracker,
      "ses_bg",
      childPart("ses_bg", {
        ...taskPart({
          callID: "call_nested",
          childId: "ses_nested",
          status: "running",
          sessionID: "ses_bg",
        }),
      }),
    );

    const stopped = stopOpenCodeSubagents(tracker);
    expect(summarize(stopped)).toEqual([
      ["task.completed", "stopped"],
      ["task.completed", "stopped"],
      ["task.completed", "stopped"],
    ]);
    expect(stopped.map((emission) => emission.payload.taskId)).toEqual([
      "ses_fg",
      "ses_bg",
      "ses_nested",
    ]);
    expect(stopped[2]?.payload).toMatchObject({ agentId: "ses_bg" });
    expect(stopOpenCodeSubagents(tracker)).toEqual([]);
  });
});
