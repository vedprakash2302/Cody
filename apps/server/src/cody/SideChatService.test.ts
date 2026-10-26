import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SideChatService from "./SideChatService.ts";
import * as SideChatStore from "./SideChatStore.ts";

const PROJECT_ID = ProjectId.make("side-chat-project");
const MAIN = ThreadId.make("side-chat-main");
const NOW = DateTime.makeUnsafe("2026-10-19T12:00:00.000Z");
const unused = () => Effect.die("Unexpected test dependency call");

const shell = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: MAIN,
  projectId: PROJECT_ID,
  title: "Main thread",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: MAIN, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  activeRunId: null,
  latestVisibleMessage: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  lastVisitedAt: null,
  deletedAt: null,
  branch: null,
  linkedPullRequest: null,
  status: "idle",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: null,
  latestRunRequestedAt: null,
  latestRunStartedAt: null,
  latestRunCompletedAt: null,
  latestUserMessageAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  ...overrides,
});

type RunFixture = Pick<OrchestrationV2Run, "status" | "checkpointId">;
const uncheckpointedRun: RunFixture = { status: "completed", checkpointId: null };
const stableRun = { status: "completed", checkpointId: "checkpoint-1" } as RunFixture;

/**
 * Stands in for the orchestrator: applies the commands a side chat sends to
 * in-memory shells, so each test checks the state the service left behind.
 */
const makeHarness = (options: {
  readonly mainRuns: ReadonlyArray<RunFixture>;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
}) =>
  Effect.gen(function* () {
    const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([[MAIN, shell()]]);
    const commands: Array<OrchestrationV2ServerCommand> = [];
    const interrupted: Array<ThreadId> = [];
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const applied = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const update = (threadId: ThreadId, change: Partial<OrchestrationV2ThreadShell>) => {
      const current = shells.get(threadId);
      if (current !== undefined) shells.set(threadId, { ...current, ...change });
    };
    const apply = (command: OrchestrationV2ServerCommand) => {
      commands.push(command);
      switch (command.type) {
        case "thread.fork": {
          const source = shells.get(command.sourceThreadId)!;
          shells.set(
            command.targetThreadId,
            shell({
              id: command.targetThreadId,
              title: command.title ?? `${source.title} fork`,
              runtimeMode: source.runtimeMode,
              lineage: {
                rootThreadId: source.lineage.rootThreadId,
                parentThreadId: source.id,
                relationshipToParent: "fork",
              },
            }),
          );
          break;
        }
        case "thread.runtime-mode.set":
          update(command.threadId, { runtimeMode: command.runtimeMode });
          break;
        case "thread.archive":
          update(command.threadId, { archivedAt: NOW });
          break;
        case "thread.unarchive":
          update(command.threadId, { archivedAt: null });
          break;
        case "thread.delete":
          update(command.threadId, { deletedAt: NOW });
          break;
        case "thread.metadata.update":
          if (command.title !== undefined) update(command.threadId, { title: command.title });
          break;
      }
    };

    const threads = ThreadManagementService.ThreadManagementService.of({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      // The service reads only `runs`, and only the parent's.
      getThreadRecords: ((threadId: ThreadId) =>
        Effect.succeed({
          thread: shells.get(threadId),
          runs: threadId === MAIN ? options.mainRuns : [],
        })) as unknown as ThreadManagementService.ThreadManagementService["Service"]["getThreadRecords"],
      dispatch: (command) =>
        Effect.sync(() => apply(command)).pipe(
          Effect.andThen(Queue.offer(applied, command)),
          Effect.as({ sequence: commands.length, storedEvents: [] }),
        ),
      interruptThread: (input) =>
        Effect.sync(() => {
          interrupted.push(input.threadId);
          update(input.threadId, { activeRunId: null });
          return { type: "no_active_run" as const };
        }),
      streamDomainEvents: Stream.fromQueue(events),
      readShellSnapshot: unused,
      listOlderSettledThreads: unused,
      ensureLegacyTranscript: unused,
      searchThread: unused,
      searchThreadStream: () => Stream.empty,
      getThreadHistoryPage: unused,
      getTimelinePage: unused,
      getMessageCount: unused,
      getTurnItem: unused,
      getThreadProjection: unused,
      getCheckpointContext: unused,
      getThreadSnapshot: unused,
      getThreadTranscript: unused,
      getThreadSnapshotWindow: unused,
      getProjectThreadRecords: unused,
      getProjectThread: unused,
      getShellSnapshot: unused,
      listActiveSubagentThreadIds: unused,
      listProjectThreads: unused,
      sendToThread: unused,
      assertProviderInstanceEnabled: unused,
      isProviderInstanceEnabledForProject: unused,
      hasReceipt: unused,
      waitForThread: unused,
      settleAfterRun: unused,
      settleThread: unused,
      stopWorkflow: unused,
      stopDelegatedTasks: unused,
      getThreadEventSequence: unused,
      recoverDelegatedTask: unused,
      delegatedTaskResultPending: unused,
      awaitBackgroundTasks: unused,
      streamStoredEvents: Stream.empty,
      streamStoredEventsFrom: () => Stream.empty,
    });
    const registry = ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (instanceId) =>
        Effect.succeed(
          ProviderAdapter.ProviderAdapterV2.of({
            instanceId,
            driver: ProviderDriverKind.make("codex"),
            getCapabilities: () =>
              Effect.succeed(options.capabilities ?? CodexProviderCapabilitiesV2),
            planSelectionTransition: unused,
            openSession: unused,
          }),
        ),
      list: () => Effect.succeed([]),
    });

    const layer = SideChatService.layer.pipe(
      Layer.provideMerge(SideChatStore.layer),
      Layer.provide(Layer.succeed(ThreadManagementService.ThreadManagementService, threads)),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, registry)),
      Layer.provide(
        Layer.succeed(
          ProjectionStore.ProjectionStoreV2,
          ProjectionStore.ProjectionStoreV2.of({} as ProjectionStore.ProjectionStoreV2Shape),
        ),
      ),
      Layer.provide(IdAllocator.layer),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cody-side-chat-test-" })),
      Layer.provide(NodeServices.layer),
    );
    return { layer, shells, commands, interrupted, events, applied };
  });

const threadEvent = (
  type: "thread.archived" | "thread.deleted",
  thread: OrchestrationV2ThreadShell,
): OrchestrationV2DomainEvent =>
  ({
    id: EventId.make(`event:${type}:${thread.id}`),
    threadId: thread.id,
    occurredAt: NOW,
    type,
    payload: thread,
  }) as unknown as OrchestrationV2DomainEvent;

describe("SideChatService", () => {
  it.effect("forks the parent's last finished run into a listed, supervised side chat", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mainRuns: [stableRun] });
      yield* Effect.gen(function* () {
        const service = yield* SideChatService.SideChatService;
        const store = yield* SideChatStore.SideChatStore;
        const opened = yield* service.open({ parentThreadId: MAIN });

        assert.isTrue(opened.created);
        assert.isTrue(store.has(opened.threadId));
        const fork = harness.commands.find((command) => command.type === "thread.fork");
        assert.deepInclude(fork, {
          sourceThreadId: MAIN,
          targetThreadId: opened.threadId,
          sourcePoint: { type: "latest_stable" },
          title: "New side chat",
        });
        assert.equal(harness.shells.get(opened.threadId)?.runtimeMode, "approval-required");

        const again = yield* service.open({ parentThreadId: MAIN });
        assert.deepEqual(again, { threadId: opened.threadId, created: false });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses a parent with no finished run, a summary-only provider, or a side chat", () =>
    Effect.gen(function* () {
      const refusal = (options: Parameters<typeof makeHarness>[0]) =>
        Effect.gen(function* () {
          const harness = yield* makeHarness(options);
          return yield* SideChatService.SideChatService.pipe(
            Effect.flatMap((service) => service.open({ parentThreadId: MAIN })),
            Effect.flip,
            Effect.map((error) => ({ reason: error.reason, commands: harness.commands.length })),
            Effect.provide(harness.layer),
          );
        });

      assert.deepEqual(yield* refusal({ mainRuns: [uncheckpointedRun] }), {
        reason: "no-finished-response",
        commands: 0,
      });
      assert.deepEqual(
        yield* refusal({ mainRuns: [stableRun], capabilities: AcpProviderCapabilitiesV2 }),
        { reason: "provider-unsupported", commands: 0 },
      );

      const harness = yield* makeHarness({ mainRuns: [stableRun] });
      const nested = yield* Effect.gen(function* () {
        const service = yield* SideChatService.SideChatService;
        const opened = yield* service.open({ parentThreadId: MAIN });
        return yield* service.open({ parentThreadId: opened.threadId }).pipe(Effect.flip);
      }).pipe(Effect.provide(harness.layer));
      assert.equal(nested.reason, "nested-side-chat");
    }),
  );

  it.effect("deletes a side chat closed before its first message and archives one after", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mainRuns: [stableRun] });
      yield* Effect.gen(function* () {
        const service = yield* SideChatService.SideChatService;
        const store = yield* SideChatStore.SideChatStore;

        const empty = yield* service.open({ parentThreadId: MAIN });
        assert.deepEqual(yield* service.close({ threadId: empty.threadId }), {
          outcome: "deleted",
        });
        assert.isNotNull(harness.shells.get(empty.threadId)?.deletedAt);
        assert.isFalse(store.has(empty.threadId));

        const used = yield* service.open({ parentThreadId: MAIN });
        const running = harness.shells.get(used.threadId)!;
        harness.shells.set(used.threadId, {
          ...running,
          latestRunId: RunId.make("run:side-chat"),
          activeRunId: RunId.make("run:side-chat"),
        });
        assert.deepEqual(yield* service.close({ threadId: used.threadId }), {
          outcome: "archived",
        });
        assert.deepEqual(harness.interrupted, [used.threadId]);
        assert.isNotNull(harness.shells.get(used.threadId)?.archivedAt);
        assert.isTrue(store.has(used.threadId));
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("promotes a side chat into an ordinary fork under its own or its parent's title", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mainRuns: [stableRun] });
      yield* Effect.gen(function* () {
        const service = yield* SideChatService.SideChatService;
        const store = yield* SideChatStore.SideChatStore;
        const opened = yield* service.open({ parentThreadId: MAIN });
        yield* service.promote({ threadId: opened.threadId });

        assert.isFalse(store.has(opened.threadId));
        assert.equal(harness.shells.get(opened.threadId)?.title, "Main thread");
        const refused = yield* service.promote({ threadId: opened.threadId }).pipe(Effect.flip);
        assert.equal(refused.reason, "not-a-side-chat");

        // A renamed side chat keeps its name, and the rename still tells clients.
        const renamed = yield* service.open({ parentThreadId: MAIN });
        harness.shells.set(renamed.threadId, {
          ...harness.shells.get(renamed.threadId)!,
          title: "Why the cache misses",
        });
        yield* service.promote({ threadId: renamed.threadId });
        assert.deepInclude(harness.commands.at(-1), {
          type: "thread.metadata.update",
          threadId: renamed.threadId,
          title: "Why the cache misses",
        });

        // Side chats from before they had names carry their parent's title.
        const legacy = yield* service.open({ parentThreadId: MAIN, fresh: true });
        harness.shells.set(legacy.threadId, {
          ...harness.shells.get(legacy.threadId)!,
          title: "Side chat · Older parent title",
        });
        yield* service.promote({ threadId: legacy.threadId });
        assert.equal(harness.shells.get(legacy.threadId)?.title, "Older parent title");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("starts side chats beside open ones and reopens one without closing others", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mainRuns: [stableRun] });
      yield* Effect.gen(function* () {
        const service = yield* SideChatService.SideChatService;
        const used = (threadId: ThreadId) =>
          harness.shells.set(threadId, {
            ...harness.shells.get(threadId)!,
            latestRunId: RunId.make(`run:${threadId}`),
          });
        const isOpen = (threadId: ThreadId) =>
          harness.shells.get(threadId)?.archivedAt === null &&
          harness.shells.get(threadId)?.deletedAt === null;

        const first = yield* service.open({ parentThreadId: MAIN });
        used(first.threadId);
        const second = yield* service.open({ parentThreadId: MAIN, fresh: true });
        used(second.threadId);
        assert.isTrue(second.created);
        assert.notEqual(second.threadId, first.threadId);
        assert.isTrue(isOpen(first.threadId));

        yield* service.close({ threadId: first.threadId });
        assert.isFalse(isOpen(first.threadId));
        assert.isTrue(isOpen(second.threadId));

        const reopened = yield* service.open({
          parentThreadId: MAIN,
          reopenThreadId: first.threadId,
        });
        assert.deepEqual(reopened, { threadId: first.threadId, created: false });
        assert.isTrue([first, second].every(({ threadId }) => isOpen(threadId)));

        harness.shells.set(second.threadId, {
          ...harness.shells.get(second.threadId)!,
          updatedAt: DateTime.add(NOW, { minutes: 1 }),
        });
        assert.deepEqual(yield* service.open({ parentThreadId: MAIN }), {
          threadId: second.threadId,
          created: false,
        });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("archives and deletes a parent's side chats with it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ mainRuns: [stableRun] });
      yield* Effect.gen(function* () {
        const service = yield* SideChatService.SideChatService;
        const store = yield* SideChatStore.SideChatStore;
        const opened = yield* service.open({ parentThreadId: MAIN });
        yield* Queue.clear(harness.applied);
        yield* service.start();

        yield* Queue.offer(harness.events, threadEvent("thread.archived", shell()));
        const archived = yield* Queue.take(harness.applied);
        assert.deepInclude(archived, { type: "thread.archive", threadId: opened.threadId });

        yield* Queue.offer(harness.events, threadEvent("thread.deleted", shell()));
        const deleted = yield* Queue.take(harness.applied);
        assert.deepInclude(deleted, { type: "thread.delete", threadId: opened.threadId });

        yield* Queue.offer(
          harness.events,
          threadEvent("thread.deleted", harness.shells.get(opened.threadId)!),
        );
        yield* store.changes.pipe(
          Stream.filter((threadIds) => !threadIds.includes(opened.threadId)),
          Stream.runHead,
        );
        assert.isFalse(store.has(opened.threadId));
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
