import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { filterShellStream, sideChatVisibility } from "./sideChatVisibility.ts";

const MAIN = ThreadId.make("visibility-main");
const SIDE_CHAT = ThreadId.make("visibility-side-chat");
const thread = (id: ThreadId) => ({ id }) as OrchestrationV2ThreadShell;
const isSideChat = (threadId: ThreadId) => threadId === SIDE_CHAT;

const snapshot: OrchestrationV2ShellSnapshot = {
  schemaVersion: 2,
  snapshotSequence: 10,
  projects: [],
  threads: [thread(MAIN), thread(SIDE_CHAT)],
  archivedThreads: [thread(SIDE_CHAT)],
};

const items: ReadonlyArray<OrchestrationV2ShellStreamItem> = [
  { kind: "snapshot", snapshot },
  { kind: "thread.updated", sequence: 11, location: "active", thread: thread(SIDE_CHAT) },
  { kind: "thread.updated", sequence: 12, location: "active", thread: thread(MAIN) },
  { kind: "thread.removed", sequence: 13, location: "active", threadId: SIDE_CHAT },
];

const deliveredTo = (clientWantsSideChats: boolean) =>
  Stream.fromIterable(items).pipe(
    filterShellStream(sideChatVisibility({ isSideChat, clientWantsSideChats })),
    Stream.runCollect,
    Effect.map((delivered) => Array.from(delivered)),
  );

describe("side chat visibility", () => {
  it.effect("keeps side chats out of the shell of a client that did not ask for them", () =>
    Effect.gen(function* () {
      const delivered = yield* deliveredTo(false);
      assert.deepEqual(delivered, [
        {
          kind: "snapshot",
          snapshot: { ...snapshot, threads: [thread(MAIN)], archivedThreads: [] },
        },
        items[2],
      ]);
    }),
  );

  it.effect("sends a Cody client every thread, with its side chats marked", () =>
    Effect.gen(function* () {
      const marked = { id: SIDE_CHAT, codySideChat: true } as OrchestrationV2ThreadShell;
      assert.deepEqual(yield* deliveredTo(true), [
        {
          kind: "snapshot",
          snapshot: { ...snapshot, threads: [thread(MAIN), marked], archivedThreads: [marked] },
        },
        { ...items[1], thread: marked },
        items[2],
        items[3],
      ] as ReadonlyArray<OrchestrationV2ShellStreamItem>);
    }),
  );
});
