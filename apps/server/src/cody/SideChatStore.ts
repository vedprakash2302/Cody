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

/**
 * For each message that carried one conversation into another, the newest run
 * of the carried conversation it covered.
 */
const CatchUps = Schema.Record(MessageId, RunId);
type CatchUps = typeof CatchUps.Type;
type CarriedBySideChat = Readonly<Record<ThreadId, CatchUps>>;

const SideChatsFile = Schema.Struct({
  version: Schema.Literal(1),
  threadIds: Schema.Array(ThreadId),
  /** Side chat messages that carried main's update. */
  catchUps: Schema.optionalKey(Schema.Record(ThreadId, CatchUps)),
  /** Thread messages that carried an attached side chat. */
  sentToThread: Schema.optionalKey(Schema.Record(ThreadId, CatchUps)),
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
    readonly sentToThread: (sideChatId: ThreadId) => CatchUps;
    /** A thread message carried this side chat through its run `sideChatRunId`. */
    readonly recordSentToThread: (
      sideChatId: ThreadId,
      threadMessageId: MessageId,
      sideChatRunId: RunId,
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
  readonly sentToThread: SideChatStore["Service"]["sentToThread"];
  readonly recordSentToThread: SideChatStore["Service"]["recordSentToThread"];
}

export class SideChatMembership extends Context.Reference<SideChatMembershipShape>(
  "t3/cody/SideChatMembership",
  {
    defaultValue: () => ({
      isSideChat: () => false,
      catchUps: () => ({}),
      recordCatchUp: () => Effect.void,
      sentToThread: () => ({}),
      recordSentToThread: () => Effect.void,
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
  let carried: { readonly catchUps: CarriedBySideChat; readonly sentToThread: CarriedBySideChat } =
    { catchUps: loaded.catchUps ?? {}, sentToThread: loaded.sentToThread ?? {} };
  const snapshot = yield* SubscriptionRef.make<ReadonlyArray<ThreadId>>([...ids]);
  const writeLock = yield* Semaphore.make(1);

  const save = (threadId: ThreadId, next: ReadonlySet<ThreadId>, nextCarried: typeof carried) =>
    encodeSideChatsFile({ version: 1, threadIds: [...next], ...nextCarried }).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new SideChatStoreWriteError({ threadId, cause })),
      Effect.andThen(
        Effect.suspend(() => {
          carried = nextCarried;
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
        if (next.has(threadId)) return save(threadId, next, carried);
        const { [threadId]: _catchUps, ...catchUps } = carried.catchUps;
        const { [threadId]: _sent, ...sentToThread } = carried.sentToThread;
        return save(threadId, next, { catchUps, sentToThread });
      }),
    );

  const record = (
    kind: keyof typeof carried,
    threadId: ThreadId,
    messageId: MessageId,
    runId: RunId,
  ) =>
    writeLock.withPermit(
      Effect.suspend(() => {
        const current = carried[kind];
        if (!ids.has(threadId) || current[threadId]?.[messageId] === runId) return Effect.void;
        return save(threadId, ids, {
          ...carried,
          [kind]: { ...current, [threadId]: { ...current[threadId], [messageId]: runId } },
        });
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
    catchUps: (threadId) => carried.catchUps[threadId] ?? {},
    recordCatchUp: Effect.fn("SideChatStore.recordCatchUp")(
      function (threadId, messageId, mainRunId) {
        return record("catchUps", threadId, messageId, mainRunId);
      },
    ),
    sentToThread: (threadId) => carried.sentToThread[threadId] ?? {},
    recordSentToThread: Effect.fn("SideChatStore.recordSentToThread")(
      function (threadId, messageId, sideChatRunId) {
        return record("sentToThread", threadId, messageId, sideChatRunId);
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
      sentToThread: store.sentToThread,
      recordSentToThread: store.recordSentToThread,
    };
  }),
);
