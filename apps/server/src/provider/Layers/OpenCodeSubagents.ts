/**
 * Maps OpenCode subagents onto the shared `task.*` runtime events that feed
 * the Agents panel, the spawn row in the timeline, and background liveness.
 *
 * OpenCode runs a subagent as a child session started by the parent's `task`
 * tool. The child's session id is the task id: it is stable across a
 * `task_id` resume and is what OpenCode names in its background completion
 * notice. Signals, in the order OpenCode sends them:
 *
 * - parent `task` tool part `running` with `metadata.sessionId` starts the agent;
 * - child session events carry its tool calls, text, and step token usage;
 * - a foreground run settles when the parent tool part completes or errors;
 * - a background run's tool part completes at launch (`metadata.background`).
 *   The child going idle means its work is done, but the outcome comes from
 *   the synthetic `<task id=… state=…>` prompt OpenCode then injects into the
 *   parent, so the run settles there (or on a child `session.error`).
 *
 * Every function here is synchronous and returns the events to emit, so the
 * adapter owns ids, timestamps, and the queue.
 */
import type { Event as OpenCodeEvent, ToolPart } from "@opencode-ai/sdk/v2";
import {
  type ProviderRuntimeEvent,
  RuntimeTaskId,
  type RuntimeTaskUsage,
  type TurnId,
} from "@t3tools/contracts";

type TaskEventType = "task.started" | "task.progress" | "task.updated" | "task.completed";

export type OpenCodeSubagentEmission = {
  [K in TaskEventType]: {
    readonly type: K;
    readonly turnId: TurnId | undefined;
    readonly payload: Extract<ProviderRuntimeEvent, { readonly type: K }>["payload"];
  };
}[TaskEventType];

interface OpenCodeSubagent {
  readonly taskId: string;
  toolUseId: string;
  title: string;
  role: string | undefined;
  model: string | undefined;
  /** Child session that launched this agent, for nested subagents. */
  readonly ownerTaskId: string | undefined;
  readonly spawnTurnId: TurnId | undefined;
  background: boolean;
  /** `idle`: a background run finished and awaits OpenCode's completion notice. */
  status: "running" | "waiting" | "idle" | "settled";
  readonly stepPartIds: Set<string>;
  readonly toolCallIds: Set<string>;
  readonly textPartIds: Set<string>;
  readonly pendingRequestIds: Set<string>;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface OpenCodeSubagentTracker {
  readonly agents: Map<string, OpenCodeSubagent>;
  /** Message roles per child session; text on user messages is the prompt. */
  readonly messageRolesBySession: Map<string, Map<string, "user" | "assistant">>;
}

export function makeOpenCodeSubagentTracker(): OpenCodeSubagentTracker {
  return { agents: new Map(), messageRolesBySession: new Map() };
}

/** Forgets every subagent, for when the thread moves to a new session. */
export function resetOpenCodeSubagentTracker(tracker: OpenCodeSubagentTracker): void {
  tracker.agents.clear();
  tracker.messageRolesBySession.clear();
}

const TASK_TYPE = "subagent";

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function modelLabel(value: unknown): string | undefined {
  const model = asRecord(value);
  const providerID = nonEmpty(model?.providerID);
  const modelID = nonEmpty(model?.modelID);
  if (!modelID) return undefined;
  return providerID ? `${providerID}/${modelID}` : modelID;
}

/** First non-empty line, for a one-line activity summary. */
function firstLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

const TASK_BLOCK_PATTERN =
  /^\s*<task id="([^"]+)" state="(running|completed|error)">[\s\S]*?<(task_result|task_error)>\n?([\s\S]*?)\n?<\/\3>/;
// OpenCode names the task in its notice: "Background task completed: <description>".
const TASK_NOTICE_TITLE_PATTERN =
  /<summary>Background task (?:completed|failed): ([^<]+)<\/summary>/;

/** Parses OpenCode's `<task id=… state=…>` wrapper around a task result. */
export function parseOpenCodeTaskBlock(text: string):
  | {
      readonly taskId: string;
      readonly state: string;
      readonly body: string;
      readonly title: string | undefined;
    }
  | undefined {
  const match = TASK_BLOCK_PATTERN.exec(text);
  if (!match) return undefined;
  return {
    taskId: match[1]!,
    state: match[2]!,
    body: match[4]?.trim() ?? "",
    title: nonEmpty(TASK_NOTICE_TITLE_PATTERN.exec(text)?.[1]),
  };
}

function linkage(agent: OpenCodeSubagent) {
  return {
    taskType: TASK_TYPE,
    title: agent.title,
    ...(agent.role ? { role: agent.role } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    toolUseId: agent.toolUseId,
    ...(agent.ownerTaskId ? { agentId: agent.ownerTaskId } : {}),
    timelineBypass: true,
  };
}

function typedUsage(agent: OpenCodeSubagent): RuntimeTaskUsage {
  return {
    totalTokens: agent.totalTokens,
    inputTokens: agent.inputTokens,
    cachedInputTokens: agent.cachedInputTokens,
    outputTokens: agent.outputTokens,
    reasoningOutputTokens: agent.reasoningTokens,
    toolUses: agent.toolCallIds.size,
  };
}

function progress(
  agent: OpenCodeSubagent,
  fields: {
    readonly summary?: string | undefined;
    readonly lastToolName?: string | undefined;
    readonly usage?: boolean;
  },
): OpenCodeSubagentEmission {
  return {
    type: "task.progress",
    turnId: agent.spawnTurnId,
    payload: {
      taskId: RuntimeTaskId.make(agent.taskId),
      description: agent.title,
      ...(fields.summary ? { summary: fields.summary } : {}),
      ...(fields.lastToolName ? { lastToolName: fields.lastToolName } : {}),
      ...(fields.usage ? { typedUsage: typedUsage(agent) } : {}),
      ...linkage(agent),
    },
  };
}

function statusUpdate(
  agent: OpenCodeSubagent,
  status: "running" | "waiting" | "idle",
): OpenCodeSubagentEmission {
  return {
    type: "task.updated",
    turnId: agent.spawnTurnId,
    payload: { taskId: RuntimeTaskId.make(agent.taskId), status, ...linkage(agent) },
  };
}

function settle(
  tracker: OpenCodeSubagentTracker,
  agent: OpenCodeSubagent,
  status: "completed" | "failed" | "stopped",
  summary: string | undefined,
): OpenCodeSubagentEmission {
  agent.status = "settled";
  agent.pendingRequestIds.clear();
  tracker.messageRolesBySession.delete(agent.taskId);
  const text = nonEmpty(summary);
  return {
    type: "task.completed",
    turnId: agent.spawnTurnId,
    payload: {
      taskId: RuntimeTaskId.make(agent.taskId),
      status,
      ...(text ? { summary: text } : {}),
      typedUsage: typedUsage(agent),
      ...linkage(agent),
    },
  };
}

/**
 * Handles a `task` tool part from the parent session, or from a child session
 * when subagents are nested (`ownerTaskId` is that child's session id).
 */
export function observeOpenCodeTaskToolPart(
  tracker: OpenCodeSubagentTracker,
  part: ToolPart,
  context: { readonly turnId: TurnId | undefined; readonly ownerTaskId?: string | undefined },
): ReadonlyArray<OpenCodeSubagentEmission> {
  if (part.tool !== "task" || part.state.status === "pending") return [];
  const metadata = asRecord(part.state.metadata);
  const taskId = nonEmpty(metadata?.sessionId);
  // A task that fails before OpenCode creates its session (unknown agent
  // type, depth limit) stays an ordinary failed tool row.
  if (!taskId) return [];
  const input = asRecord(part.state.input);
  const title = nonEmpty(input?.description) ?? "Subagent";
  const role = nonEmpty(input?.subagent_type);
  const model = modelLabel(metadata?.model);
  const background = metadata?.background === true;

  const emissions: OpenCodeSubagentEmission[] = [];
  let agent = tracker.agents.get(taskId);
  if (!agent) {
    agent = {
      taskId,
      toolUseId: part.callID,
      title,
      role,
      model,
      ownerTaskId: context.ownerTaskId,
      spawnTurnId: context.turnId,
      background,
      status: "running",
      stepPartIds: new Set(),
      toolCallIds: new Set(),
      textPartIds: new Set(),
      pendingRequestIds: new Set(),
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
    tracker.agents.set(taskId, agent);
    emissions.push({
      type: "task.started",
      turnId: agent.spawnTurnId,
      payload: {
        taskId: RuntimeTaskId.make(taskId),
        description: title,
        ...linkage(agent),
      },
    });
  } else if (agent.toolUseId !== part.callID) {
    // A new `task` call naming an existing session: `task_id` resume, or
    // extra context sent to a running background task.
    agent.toolUseId = part.callID;
    agent.title = title;
    agent.role = role ?? agent.role;
    agent.model = model ?? agent.model;
    agent.background = background;
    const reactivated = agent.status === "settled" || agent.status === "idle";
    if (reactivated) {
      agent.status = "running";
    }
    emissions.push({
      type: "task.started",
      turnId: agent.spawnTurnId,
      payload: { taskId: RuntimeTaskId.make(taskId), description: title, ...linkage(agent) },
    });
    if (reactivated) {
      emissions.push(statusUpdate(agent, "running"));
    }
  } else {
    agent.background = agent.background || background;
  }

  if (agent.status === "settled") return emissions;
  if (part.state.status === "completed") {
    // A background launch completes its tool call at once; the run goes on.
    if (!agent.background) {
      const block = parseOpenCodeTaskBlock(part.state.output);
      emissions.push(settle(tracker, agent, "completed", block?.body ?? part.state.output));
    }
  } else if (part.state.status === "error") {
    emissions.push(settle(tracker, agent, "failed", part.state.error));
  }
  return emissions;
}

function sessionErrorText(error: unknown): string | undefined {
  const data = asRecord(asRecord(error)?.data);
  return nonEmpty(data?.message) ?? nonEmpty(asRecord(error)?.name);
}

/** Handles an event from a child session of the thread's OpenCode session. */
export function observeOpenCodeChildEvent(
  tracker: OpenCodeSubagentTracker,
  sessionId: string,
  event: OpenCodeEvent,
): ReadonlyArray<OpenCodeSubagentEmission> {
  const agent = tracker.agents.get(sessionId);
  switch (event.type) {
    case "message.updated": {
      const { info } = event.properties;
      if (agent?.status === "settled") return [];
      const roles =
        tracker.messageRolesBySession.get(sessionId) ?? new Map<string, "user" | "assistant">();
      roles.set(info.id, info.role);
      tracker.messageRolesBySession.set(sessionId, roles);
      return [];
    }
    case "message.part.updated": {
      const { part } = event.properties;
      if (part.type === "tool") {
        const nested =
          part.tool === "task"
            ? observeOpenCodeTaskToolPart(tracker, part, {
                turnId: agent?.spawnTurnId,
                ownerTaskId: sessionId,
              })
            : [];
        if (!agent || agent.status === "settled" || agent.toolCallIds.has(part.callID)) {
          return nested;
        }
        agent.toolCallIds.add(part.callID);
        return [...nested, progress(agent, { lastToolName: part.tool })];
      }
      if (!agent || agent.status === "settled") return [];
      if (part.type === "step-finish") {
        if (agent.stepPartIds.has(part.id)) return [];
        agent.stepPartIds.add(part.id);
        const { tokens } = part;
        const input = tokens.input + tokens.cache.read + tokens.cache.write;
        agent.inputTokens += input;
        agent.cachedInputTokens += tokens.cache.read;
        agent.outputTokens += tokens.output + tokens.reasoning;
        agent.reasoningTokens += tokens.reasoning;
        agent.totalTokens += input + tokens.output + tokens.reasoning;
        return [progress(agent, { usage: true })];
      }
      if (part.type === "text") {
        const role = tracker.messageRolesBySession.get(sessionId)?.get(part.messageID);
        if (role !== "assistant" || part.synthetic) return [];
        const text = nonEmpty(part.text);
        if (!text) return [];
        // Emit once per finished text part, not per streamed update.
        if (part.time?.end === undefined || agent.textPartIds.has(part.id)) return [];
        agent.textPartIds.add(part.id);
        return [progress(agent, { summary: firstLine(text) })];
      }
      return [];
    }
    case "session.status": {
      // A foreground run settles on the parent's tool result, which carries
      // the text the parent actually received.
      if (
        !agent ||
        !agent.background ||
        event.properties.status.type !== "idle" ||
        agent.status === "settled" ||
        agent.status === "idle"
      ) {
        return [];
      }
      agent.status = "idle";
      agent.pendingRequestIds.clear();
      return [statusUpdate(agent, "idle")];
    }
    case "session.error": {
      if (!agent || agent.status === "settled" || !agent.background) return [];
      const { error } = event.properties;
      return asRecord(error)?.name === "MessageAbortedError"
        ? [settle(tracker, agent, "stopped", undefined)]
        : [settle(tracker, agent, "failed", sessionErrorText(error))];
    }
    case "permission.asked":
    case "question.asked": {
      if (!agent || agent.status === "settled") return [];
      agent.pendingRequestIds.add(event.properties.id);
      if (agent.status === "waiting") return [];
      agent.status = "waiting";
      return [statusUpdate(agent, "waiting")];
    }
    case "permission.replied":
    case "question.replied":
    case "question.rejected": {
      if (!agent || agent.status === "settled") return [];
      agent.pendingRequestIds.delete(event.properties.requestID);
      if (agent.status !== "waiting" || agent.pendingRequestIds.size > 0) return [];
      agent.status = "running";
      return [statusUpdate(agent, "running")];
    }
    default:
      return [];
  }
}

/**
 * Handles OpenCode's synthetic notice that a background task finished, which
 * it injects into the parent session as a user text part.
 */
export function observeOpenCodeTaskNotification(
  tracker: OpenCodeSubagentTracker,
  text: string,
): ReadonlyArray<OpenCodeSubagentEmission> {
  const block = parseOpenCodeTaskBlock(text);
  if (!block || block.state === "running") return [];
  const status = block.state === "error" ? "failed" : "completed";
  const agent = tracker.agents.get(block.taskId);
  if (agent) {
    return agent.status === "settled" ? [] : [settle(tracker, agent, status, block.body)];
  }
  // Launched before this adapter started (server restart, resume). Its
  // earlier rows are persisted, so a bare completion is enough to settle it.
  const body = nonEmpty(block.body);
  return [
    {
      type: "task.completed",
      turnId: undefined,
      payload: {
        taskId: RuntimeTaskId.make(block.taskId),
        status,
        ...(body ? { summary: body } : {}),
        taskType: TASK_TYPE,
        ...(block.title ? { title: block.title } : {}),
        timelineBypass: true,
      },
    },
  ];
}

/**
 * Settles foreground subagents still open when their turn ends. A foreground
 * run cannot outlive the parent turn that waits on it, so one still open means
 * its result event was lost (for example across a reconnect). Background runs,
 * and agents launched inside them, belong to no turn and are left alone.
 */
export function settleForegroundOpenCodeSubagents(
  tracker: OpenCodeSubagentTracker,
  status: "completed" | "stopped",
): ReadonlyArray<OpenCodeSubagentEmission> {
  const underBackground = (agent: OpenCodeSubagent): boolean => {
    for (let current: OpenCodeSubagent | undefined = agent; current;) {
      if (current.background) return true;
      current = current.ownerTaskId ? tracker.agents.get(current.ownerTaskId) : undefined;
    }
    return false;
  };
  const emissions: OpenCodeSubagentEmission[] = [];
  for (const agent of tracker.agents.values()) {
    if (agent.status === "settled" || underBackground(agent)) continue;
    emissions.push(settle(tracker, agent, status, undefined));
  }
  return emissions;
}

/**
 * Settles every running subagent as stopped after an interrupt aborted the
 * tree. Idle ones had already finished their work, so they keep that state.
 */
export function stopOpenCodeSubagents(
  tracker: OpenCodeSubagentTracker,
): ReadonlyArray<OpenCodeSubagentEmission> {
  const emissions: OpenCodeSubagentEmission[] = [];
  for (const agent of tracker.agents.values()) {
    if (agent.status === "settled" || agent.status === "idle") continue;
    emissions.push(settle(tracker, agent, "stopped", undefined));
  }
  return emissions;
}
