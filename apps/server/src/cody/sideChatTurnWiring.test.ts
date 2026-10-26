import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  type ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ContextHandoffService from "../orchestration-v2/ContextHandoffService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnControl from "../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderTurnStart from "../orchestration-v2/ProviderTurnStartService.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SideChatStore from "./SideChatStore.ts";
import { SIDE_CHAT_RULES } from "./sideChatRules.ts";

// These run upstream's turn services, so a merge that drops Cody's calls into
// them fails here even when the Cody functions' own tests still pass.

const now = DateTime.makeUnsafe("2026-10-26T12:00:00Z");
const THREAD = ThreadId.make("wiring-thread");
const SIDE_CHAT = ThreadId.make("wiring-side-chat");
const runId = RunId.make("wiring-run-2");
const rootNodeId = NodeId.make("wiring-root-2");
const attemptId = RunAttemptId.make("wiring-attempt-2");
const messageId = MessageId.make("wiring-message-2");
const providerThreadId = ProviderThreadId.make("wiring-provider-thread");
const providerSessionId = ProviderSessionId.make("wiring-provider-session");
const providerTurnId = ProviderTurnId.make("wiring-provider-turn");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");

const sideChatRecord: ThreadContextRecord = {
  version: 1,
  kind: "thread",
  contextId: toKindScopedComposerContextId("thread", SIDE_CHAT),
  label: "Retry logic · 1 new",
  environmentId: EnvironmentId.make("env"),
  threadId: SIDE_CHAT,
  title: "Retry logic · 1 new",
};
const MESSAGE_TEXT = `${formatComposerContextReference(sideChatRecord)} ship it`;

const sideChatProjection = {
  thread: { id: SIDE_CHAT, title: "Retry logic" },
  runs: [
    {
      id: RunId.make("side-run-1"),
      ordinal: 1,
      status: "completed",
      completedAt: now,
      userMessageId: MessageId.make("side-message-1"),
      activeAttemptId: null,
    },
  ],
  messages: [
    { id: MessageId.make("side-message-1"), role: "user", text: "is retry safe?" },
    { id: MessageId.make("side-message-2"), role: "assistant", text: "Yes, it is idempotent." },
  ].map((message) => ({ ...message, runId: RunId.make("side-run-1"), streaming: false })),
  turnItems: [],
  providerTurns: [],
  checkpoints: [],
} as unknown as OrchestrationV2ThreadProjection;

const membership = (recorded: Array<RunId>): SideChatStore.SideChatMembershipShape => ({
  isSideChat: (threadId) => threadId === SIDE_CHAT,
  catchUps: () => ({}),
  recordCatchUp: () => Effect.void,
  sentToThread: () => ({}),
  recordSentToThread: (_sideChatId, _messageId, runId) =>
    Effect.sync(() => void recorded.push(runId)),
});

const recordsFor = (projection: () => OrchestrationV2ThreadProjection) => (threadId: ThreadId) =>
  Effect.succeed(threadId === SIDE_CHAT ? sideChatProjection : projection());

const assertCarriesSideChat = (text: string | undefined) => {
  assert.include(text, '<side-chat-context>\nThe user attached their side chat "Retry logic"');
  assert.include(text, "User: is retry safe?\nAssistant: Yes, it is idempotent.");
  assert.isTrue(text?.endsWith("</side-chat-context>\n\nship it"));
};

function threadProjection(): OrchestrationV2ThreadProjection {
  const run = {
    id: runId,
    threadId: THREAD,
    ordinal: 2,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  } as const;
  const checkpointScopeId = CheckpointScopeId.make("wiring-scope");
  return {
    thread: {
      id: THREAD,
      activeProviderThreadId: providerThreadId,
      projectId: ProjectId.make("wiring-project"),
      branch: null,
      worktreePath: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD },
      forkedFrom: null,
    } as unknown as OrchestrationV2ThreadProjection["thread"],
    runs: [
      {
        ...run,
        id: RunId.make("wiring-run-1"),
        ordinal: 1,
        status: "completed",
        rootNodeId: NodeId.make("wiring-root-1"),
        activeAttemptId: RunAttemptId.make("wiring-attempt-1"),
        userMessageId: MessageId.make("wiring-message-1"),
        completedAt: now,
      },
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId: THREAD,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId,
        appThreadId: THREAD,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "wiring-native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId: THREAD,
        runId,
        nodeId: rootNodeId,
        role: "user",
        text: MESSAGE_TEXT,
        context: { version: 1, records: [sideChatRecord] },
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId: THREAD,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/side-chat-wiring",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
}

const providerSession = {
  id: providerSessionId,
  driver,
  providerInstanceId: instanceId,
  status: "ready",
  cwd: "/tmp/side-chat-wiring",
  model: null,
  capabilities: CodexProviderCapabilitiesV2,
  createdAt: now,
  updatedAt: now,
  lastError: null,
} as const;

const startTurn = (sideChats: SideChatStore.SideChatMembershipShape) =>
  Effect.gen(function* () {
    let projection = threadProjection();
    let sentText: string | undefined;
    const turnStartContext = () => Effect.sync(() => ({ ...projection, hasConversation: true }));
    const layer = ProviderTurnStart.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: ({ events }) =>
              Effect.sync(() => {
                for (const event of events) {
                  projection = ProjectionStore.applyToProjection(projection, event);
                }
                return { committed: true, storedEvents: [] };
              }),
          }),
          IdAllocator.layer,
          Path.layer,
          Layer.mock(ServerConfig.ServerConfig)({
            worktreesDir: "/tmp/side-chat-wiring-worktrees",
          } as ServerConfig.ServerConfig["Service"]),
          ServerSettings.layerTest(),
          FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
          Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees: () => Effect.void }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ workspaceRoot: "/tmp/side-chat-wiring" } as never),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: recordsFor(() => projection),
            getTurnStartContext: turnStartContext,
            getRuntimeRecoveryProjection: turnStartContext,
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                driver,
                providerSession,
                ensureThread: () => Effect.succeed(projection.providerThreads[0]!),
                resumeThread: () => Effect.succeed(projection.providerThreads[0]!),
              } as never),
            get: () => Effect.succeedNone,
          }),
          Layer.mock(ProviderAuthService.ProviderAuthService)({
            tryHandlePromptCommand: () => Effect.succeed(false),
          }),
          Layer.mock(RunExecutionService.RunExecutionServiceV2)({
            startRootRun: (input) =>
              Effect.sync(() => {
                sentText = input.message.text;
              }),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: () => Effect.succeed({ cwd: "/tmp/side-chat-wiring" } as never),
          }),
          Layer.succeed(SideChatStore.SideChatMembership, sideChats),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId: THREAD,
        runId,
      });
    }).pipe(Effect.provide(layer));
    return sentText;
  });

describe("upstream turn services carry side chat context", () => {
  it.effect("a thread turn's start carries an attached side chat", () =>
    Effect.gen(function* () {
      const recorded: Array<RunId> = [];
      assertCarriesSideChat(yield* startTurn(membership(recorded)));
      assert.deepEqual(recorded, [RunId.make("side-run-1")]);
    }),
  );

  it.effect("a side chat turn's start carries the side chat rules", () =>
    Effect.gen(function* () {
      const text = yield* startTurn({
        ...membership([]),
        isSideChat: (threadId) => threadId === THREAD,
      });
      assert.isTrue(text?.startsWith(SIDE_CHAT_RULES));
    }),
  );

  it.effect("a message steered into a running thread turn", () =>
    Effect.gen(function* () {
      const projection = threadProjection();
      const recorded: Array<RunId> = [];
      let sentText: string | undefined;
      const providerThread = projection.providerThreads[0]!;
      const runtime = {
        driver,
        providerSessionId,
        providerSession,
        steerTurn: (input: ProviderAdapter.ProviderAdapterV2SteerInput) =>
          Effect.sync(() => {
            sentText = input.message.text;
          }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const layer = ProviderTurnControl.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadRecords: recordsFor(() => projection),
              getProviderControlContext: () =>
                Effect.succeed({
                  providerThread,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId,
                    nodeId: rootNodeId,
                    runAttemptId: attemptId,
                    nativeTurnRef: null,
                    ordinal: 2,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                  attempt: undefined,
                  message: projection.messages[0],
                  run: projection.runs[1],
                }),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () => Effect.succeedSome(runtime),
            }),
            Layer.succeed(SideChatStore.SideChatMembership, membership(recorded)),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        yield* (yield* ProviderTurnControl.ProviderTurnControlServiceV2).steer({
          threadId: THREAD,
          providerSessionId,
          providerThreadId,
          providerTurnId,
          messageId,
        });
      }).pipe(Effect.provide(layer));

      assertCarriesSideChat(sentText);
      assert.deepEqual(recorded, [RunId.make("side-run-1")]);
    }),
  );
});
