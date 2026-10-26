import {
  CommandId,
  CodySideChatError,
  type CodySideChatCloseResult,
  type CodySideChatOpenInput,
  type CodySideChatOpenResult,
  type CodySideChatThreadInput,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as SideChatStore from "./SideChatStore.ts";

const SIDE_CHAT_TITLE_PREFIX = "Side chat · ";

export const sideChatTitle = (parentTitle: string) => `${SIDE_CHAT_TITLE_PREFIX}${parentTitle}`;

/** The title a promoted side chat keeps, or undefined when the user already renamed it. */
export const promotedTitle = (title: string) =>
  title.startsWith(SIDE_CHAT_TITLE_PREFIX) && title.length > SIDE_CHAT_TITLE_PREFIX.length
    ? title.slice(SIDE_CHAT_TITLE_PREFIX.length)
    : undefined;

const isLiveShell = (
  shell: OrchestrationV2ThreadShell | null,
): shell is OrchestrationV2ThreadShell => shell !== null && shell.deletedAt === null;

export class SideChatService extends Context.Service<
  SideChatService,
  {
    /** Returns the parent's open side chat when it has one, so a parent has at most one open. */
    readonly open: (
      input: CodySideChatOpenInput,
    ) => Effect.Effect<CodySideChatOpenResult, CodySideChatError>;
    readonly close: (
      input: CodySideChatThreadInput,
    ) => Effect.Effect<CodySideChatCloseResult, CodySideChatError>;
    /** Turns the side chat into an ordinary fork, which every client lists. */
    readonly promote: (input: CodySideChatThreadInput) => Effect.Effect<void, CodySideChatError>;
    /** Archives and deletes a parent's side chats with it. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/cody/SideChatService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const store = yield* SideChatStore.SideChatStore;
  const crypto = yield* Crypto.Crypto;
  const openLocks = yield* KeyedLock.make<ThreadId>();

  // Close can repeat on one thread (reopen, close again), so its commands
  // need fresh ids; a reused id only replays the first receipt.
  const freshCommandId = (threadId: ThreadId, action: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`cody:side-chat:${threadId}:${action}:${uuid}`)),
    );

  const shellOf = (threadId: ThreadId) =>
    threads
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError(
          (cause) => new CodySideChatError({ threadId, reason: "thread-not-found", cause }),
        ),
      );

  const sideChatsOf = Effect.fn("SideChatService.sideChatsOf")(function* (
    parentThreadId: ThreadId,
  ) {
    const shells = yield* Effect.forEach(
      yield* store.list,
      (threadId) => threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 8 },
    );
    return shells
      .filter(isLiveShell)
      .filter((shell) => shell.lineage.parentThreadId === parentThreadId);
  });

  const requireSideChat = (threadId: ThreadId) =>
    store.has(threadId)
      ? Effect.void
      : Effect.fail(new CodySideChatError({ threadId, reason: "not-a-side-chat" }));

  const supportsNativeFork = (shell: OrchestrationV2ThreadShell) =>
    registry.get(shell.modelSelection.instanceId).pipe(
      Effect.flatMap((adapter) => adapter.getCapabilities()),
      Effect.map(
        (capabilities) =>
          capabilities.threads.canForkThread &&
          capabilities.threads.canForkFromTurn &&
          capabilities.identity.nativeThreadIds === "strong",
      ),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Closes one side chat: deleted when nothing was asked yet, otherwise its
   * turn stops and it is archived, so it can be reopened.
   */
  const closeShell = Effect.fn("SideChatService.closeShell")(function* (
    shell: OrchestrationV2ThreadShell,
  ) {
    const threadId = shell.id;
    const fail = (reason: CodySideChatError["reason"], cause?: unknown) =>
      new CodySideChatError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });
    if (shell.latestRunId === null) {
      yield* threads
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`cody:side-chat:${threadId}:close-delete`),
          threadId,
        })
        .pipe(Effect.mapError((cause) => fail("dispatch-failed", cause)));
      yield* store.remove(threadId).pipe(Effect.mapError((cause) => fail("store-failed", cause)));
      return "deleted" as const;
    }
    if (shell.activeRunId !== null) {
      yield* threads
        .interruptThread({
          projectId: shell.projectId,
          commandId: yield* freshCommandId(threadId, "close-interrupt"),
          threadId,
          reason: "Side chat closed",
        })
        .pipe(Effect.mapError((cause) => fail("dispatch-failed", cause)));
    }
    if (shell.archivedAt === null) {
      yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: yield* freshCommandId(threadId, "close-archive"),
          threadId,
        })
        .pipe(Effect.mapError((cause) => fail("dispatch-failed", cause)));
    }
    return "archived" as const;
  });

  const open: SideChatService["Service"]["open"] = Effect.fn("SideChatService.open")(
    function* (input) {
      const parentThreadId = input.parentThreadId;
      const fail = (reason: CodySideChatError["reason"], cause?: unknown) =>
        new CodySideChatError({
          threadId: parentThreadId,
          reason,
          ...(cause === undefined ? {} : { cause }),
        });
      if (store.has(parentThreadId)) return yield* fail("nested-side-chat");
      const parent = yield* shellOf(parentThreadId);
      if (!isLiveShell(parent)) return yield* fail("thread-not-found");

      const sideChats = yield* sideChatsOf(parentThreadId);
      const openSideChats = sideChats
        .filter((shell) => shell.archivedAt === null)
        .toSorted(
          (left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds,
        );
      // A parent keeps at most one open side chat, so reopening or starting
      // fresh closes the others first.
      const closeOpenExcept = (keep: ThreadId | null) =>
        Effect.forEach(
          openSideChats.filter((shell) => shell.id !== keep),
          closeShell,
          { discard: true },
        );

      if (input.reopenThreadId !== undefined) {
        const reopenThreadId = input.reopenThreadId;
        const target = sideChats.find((shell) => shell.id === reopenThreadId);
        if (target === undefined || !store.has(target.id)) {
          return yield* new CodySideChatError({
            threadId: reopenThreadId,
            reason: "not-a-side-chat",
          });
        }
        yield* closeOpenExcept(target.id);
        if (target.archivedAt !== null) {
          yield* threads
            .dispatch({
              type: "thread.unarchive",
              commandId: yield* freshCommandId(target.id, "reopen"),
              threadId: target.id,
            })
            .pipe(Effect.mapError((cause) => fail("dispatch-failed", cause)));
        }
        return { threadId: target.id, created: false };
      }

      if (input.fresh !== true && openSideChats[0] !== undefined) {
        return { threadId: openSideChats[0].id, created: false };
      }

      // `latest_stable` forks the newest completed run with a checkpoint, so a
      // running parent still has a fork point once one turn has finished.
      const { runs } = yield* threads
        .getThreadRecords(parentThreadId, ["runs"])
        .pipe(Effect.mapError((cause) => fail("thread-not-found", cause)));
      if (!runs.some((run) => run.status === "completed" && run.checkpointId !== null)) {
        return yield* fail("no-finished-response");
      }
      // Providers without a native fork only pass a truncated summary, which is
      // too thin to ask about the thread.
      if (!(yield* supportsNativeFork(parent))) return yield* fail("provider-unsupported");
      yield* closeOpenExcept(null);

      const threadId = yield* ids.allocate
        .thread({ projectId: parent.projectId })
        .pipe(Effect.mapError((cause) => fail("dispatch-failed", cause)));
      // Listed before the fork commits, so no client that hides side chats
      // ever receives this thread.
      yield* store.add(threadId).pipe(Effect.mapError((cause) => fail("store-failed", cause)));
      yield* threads
        .dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`cody:side-chat:${threadId}:fork`),
          createdBy: "user",
          creationSource: input.creationSource ?? "web",
          sourceThreadId: parentThreadId,
          targetThreadId: threadId,
          sourcePoint: { type: "latest_stable" },
          title: sideChatTitle(parent.title),
        })
        .pipe(
          Effect.tapError(() => store.remove(threadId).pipe(Effect.ignore)),
          Effect.mapError((cause) => fail("dispatch-failed", cause)),
        );
      // Side chats edit the same files as their parent, so edits and commands
      // ask first. One left in the parent's mode would not, so it goes.
      yield* threads
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`cody:side-chat:${threadId}:runtime-mode`),
          threadId,
          runtimeMode: "approval-required",
        })
        .pipe(
          Effect.tapError(() =>
            threads
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`cody:side-chat:${threadId}:runtime-mode-failed`),
                threadId,
              })
              .pipe(Effect.andThen(store.remove(threadId)), Effect.ignore),
          ),
          Effect.mapError((cause) => fail("dispatch-failed", cause)),
        );
      return { threadId, created: true };
    },
    (effect, input) => openLocks.withLock(input.parentThreadId, effect),
  );

  const close: SideChatService["Service"]["close"] = Effect.fn("SideChatService.close")(
    function* (input) {
      const threadId = input.threadId;
      yield* requireSideChat(threadId);
      const shell = yield* shellOf(threadId);
      if (!isLiveShell(shell)) {
        yield* store
          .remove(threadId)
          .pipe(
            Effect.mapError(
              (cause) => new CodySideChatError({ threadId, reason: "store-failed", cause }),
            ),
          );
        return { outcome: "deleted" as const };
      }
      const closing = closeShell(shell);
      const parentThreadId = shell.lineage.parentThreadId;
      return {
        outcome:
          parentThreadId === null
            ? yield* closing
            : yield* openLocks.withLock(parentThreadId, closing),
      };
    },
  );

  const promote: SideChatService["Service"]["promote"] = Effect.fn("SideChatService.promote")(
    function* (input) {
      const threadId = input.threadId;
      const fail = (reason: CodySideChatError["reason"], cause?: unknown) =>
        new CodySideChatError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });
      yield* requireSideChat(threadId);
      const shell = yield* shellOf(threadId);
      if (!isLiveShell(shell)) return yield* fail("thread-not-found");
      yield* store.remove(threadId).pipe(Effect.mapError((cause) => fail("store-failed", cause)));
      // Clients hear about a thread through its events, so a rename is what
      // makes the promoted thread appear in their lists. It renames even to
      // the same title, which still sends the event.
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`cody:side-chat:${threadId}:promote`),
          threadId,
          title: promotedTitle(shell.title) ?? shell.title,
        })
        .pipe(Effect.mapError((cause) => fail("dispatch-failed", cause)));
    },
  );

  const followParent = Effect.fn("SideChatService.followParent")(
    function* (event: OrchestrationV2DomainEvent) {
      if (event.type !== "thread.archived" && event.type !== "thread.deleted") return;
      if (store.has(event.threadId)) {
        if (event.type === "thread.deleted") yield* store.remove(event.threadId);
        return;
      }
      const sideChats = (yield* sideChatsOf(event.threadId)).filter(
        (shell) => event.type === "thread.deleted" || shell.archivedAt === null,
      );
      yield* Effect.forEach(
        sideChats,
        (shell) =>
          threads.dispatch(
            event.type === "thread.deleted"
              ? {
                  type: "thread.delete",
                  commandId: CommandId.make(`cody:side-chat:${shell.id}:parent-deleted`),
                  threadId: shell.id,
                }
              : {
                  type: "thread.archive",
                  commandId: CommandId.make(
                    `cody:side-chat:${shell.id}:parent-archived:${event.id}`,
                  ),
                  threadId: shell.id,
                },
          ),
        { discard: true },
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not follow a side chat's parent.", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  // Ids whose thread is gone, such as one deleted while the server was down.
  const forgetMissing = Effect.gen(function* () {
    const listed = yield* store.list;
    const shells = yield* Effect.forEach(
      listed,
      (threadId) => threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => undefined)),
      { concurrency: 8 },
    );
    yield* Effect.forEach(
      listed.filter((_, index) => shells[index] === null || shells[index]?.deletedAt != null),
      store.remove,
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not prune the side chat list.", cause)),
  );

  const start: SideChatService["Service"]["start"] = Effect.fn("SideChatService.start")(
    function* () {
      yield* forkParked(
        forgetMissing.pipe(
          Effect.andThen(Stream.runForEach(threads.streamDomainEvents, followParent)),
          Effect.catchCause((cause) =>
            Effect.logWarning("The side chat parent follower stopped.", cause),
          ),
        ),
      );
    },
  );

  return SideChatService.of({ open, close, promote, start });
});

export const layer = Layer.effect(SideChatService, make);
