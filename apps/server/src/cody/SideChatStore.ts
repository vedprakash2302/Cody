import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";

const SIDE_CHATS_FILE = "cody-side-chats.json";

/** For each side chat message that carried main's update, main's newest run it covered. */
const CatchUps = Schema.Record(MessageId, RunId);
type CatchUps = typeof CatchUps.Type;

const SideChatsFile = Schema.Struct({
  version: Schema.Literal(1),
  threadIds: Schema.Array(ThreadId),
  catchUps: Schema.optionalKey(Schema.Record(ThreadId, CatchUps)),
});
const SideChatsFileJson = Schema.fromJsonString(SideChatsFile);
const decodeSideChatsFile = Schema.decodeUnknownEffect(SideChatsFileJson);
const encodeSideChatsFile = Schema.encodeEffect(SideChatsFileJson);

export class SideChatStoreWriteError extends Schema.TaggedError<SideChatStoreWriteError>()(
  "SideChatStoreWriteError",
  {
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to save the side chat list.";
  }
}

/**
 * The ids of Cody's side chats. Kept outside statev2.sqlite so the official
 * server can open the same data: without this file a side chat is an ordinary
 * fork. Parent and open/closed state come from the thread itself.
 */
export class SideChatStore extends Context.Service<
  SideChatStore,
  {
    readonly has: (threadId: ThreadId) => boolean;
    readonly list: Effect.Effect<ReadonlyArray<ThreadId>>;
    readonly add: (threadId: ThreadId) => Effect.Effect<void, SideChatStoreWriteError>;
    readonly remove: (threadId: ThreadId) => Effect.Effect<void, SideChatStoreWriteError>;
    readonly catchUps: (threadId: ThreadId) => CatchUps;
    readonly recordCatchUp: (
      threadId: ThreadId,
      messageId: MessageId,
      mainRunId: RunId,
    ) => Effect.Effect<void, SideChatStoreWriteError>;
    readonly changes: Stream.Stream<ReadonlyArray<ThreadId>>;
  }
>()("t3/cody/SideChatStore") {}

/**
 * Upstream code that has to treat side chats differently reads this instead of
 * the store, so its existing layers and tests need nothing new: without the
 * store layer every thread is an ordinary thread.
 */
export interface SideChatMembershipShape {
  readonly isSideChat: (threadId: ThreadId) => boolean;
  readonly catchUps: SideChatStore["Service"]["catchUps"];
  readonly recordCatchUp: SideChatStore["Service"]["recordCatchUp"];
}

export class SideChatMembership extends Context.Reference<SideChatMembershipShape>(
  "t3/cody/SideChatMembership",
  {
    defaultValue: () => ({
      isSideChat: () => false,
      catchUps: () => ({}),
      recordCatchUp: () => Effect.void,
    }),
  },
) {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, SIDE_CHATS_FILE);

  const empty: typeof SideChatsFile.Type = { version: 1, threadIds: [] };
  const loaded = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeSideChatsFile),
    Effect.catchCause((cause) =>
      fileSystem.exists(filePath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((exists) =>
          exists
            ? Effect.logWarning("Ignoring an unreadable side chat list.", cause).pipe(
                Effect.as(empty),
              )
            : Effect.succeed(empty),
        ),
      ),
    ),
  );

  // Read on every shell item and turn start, so lookups stay synchronous.
  let ids: ReadonlySet<ThreadId> = new Set(loaded.threadIds);
  let catchUps: Readonly<Record<ThreadId, CatchUps>> = loaded.catchUps ?? {};
  const snapshot = yield* SubscriptionRef.make<ReadonlyArray<ThreadId>>([...ids]);
  const writeLock = yield* Semaphore.make(1);

  const save = (
    threadId: ThreadId,
    next: ReadonlySet<ThreadId>,
    nextCatchUps: Readonly<Record<ThreadId, CatchUps>>,
  ) =>
    encodeSideChatsFile({ version: 1, threadIds: [...next], catchUps: nextCatchUps }).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new SideChatStoreWriteError({ threadId, cause })),
      Effect.andThen(
        Effect.suspend(() => {
          catchUps = nextCatchUps;
          if (next === ids) return Effect.void;
          ids = next;
          return SubscriptionRef.set(snapshot, [...next]);
        }),
      ),
    );

  const update = (threadId: ThreadId, change: (current: Set<ThreadId>) => void) =>
    writeLock.withPermit(
      Effect.suspend(() => {
        const next = new Set(ids);
        change(next);
        if (next.size === ids.size && [...next].every((id) => ids.has(id))) return Effect.void;
        const { [threadId]: _forgotten, ...nextCatchUps } = catchUps;
        return save(threadId, next, next.has(threadId) ? catchUps : nextCatchUps);
      }),
    );

  return SideChatStore.of({
    has: (threadId) => ids.has(threadId),
    list: SubscriptionRef.get(snapshot),
    add: Effect.fn("SideChatStore.add")(function (threadId) {
      return update(threadId, (next) => void next.add(threadId));
    }),
    remove: Effect.fn("SideChatStore.remove")(function (threadId) {
      return update(threadId, (next) => void next.delete(threadId));
    }),
    catchUps: (threadId) => catchUps[threadId] ?? {},
    recordCatchUp: Effect.fn("SideChatStore.recordCatchUp")(
      function (threadId, messageId, mainRunId) {
        return writeLock.withPermit(
          Effect.suspend(() =>
            !ids.has(threadId) || catchUps[threadId]?.[messageId] === mainRunId
              ? Effect.void
              : save(threadId, ids, {
                  ...catchUps,
                  [threadId]: { ...catchUps[threadId], [messageId]: mainRunId },
                }),
          ),
        );
      },
    ),
    changes: SubscriptionRef.changes(snapshot),
  });
});

export const layer = Layer.effect(SideChatStore, make);

export const layerMembership = Layer.effect(
  SideChatMembership,
  Effect.gen(function* () {
    const store = yield* SideChatStore;
    return {
      isSideChat: store.has,
      catchUps: store.catchUps,
      recordCatchUp: store.recordCatchUp,
    };
  }),
);
