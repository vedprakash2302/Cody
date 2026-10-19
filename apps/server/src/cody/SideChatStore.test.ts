import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as SideChatStore from "./SideChatStore.ts";

const SIDE_CHAT = ThreadId.make("side-chat-store-thread");

const storeAt = (baseDir: string) =>
  Layer.merge(
    SideChatStore.layer,
    SideChatStore.layerMembership.pipe(Layer.provide(SideChatStore.layer)),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

describe("SideChatStore", () => {
  it.effect("keeps side chats across a restart and forgets removed ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cody-side-chat-store-" });

      yield* Effect.gen(function* () {
        const store = yield* SideChatStore.SideChatStore;
        yield* store.add(SIDE_CHAT);
        assert.isTrue((yield* SideChatStore.SideChatMembership).isSideChat(SIDE_CHAT));
      }).pipe(Effect.provide(storeAt(baseDir)));

      const afterRestart = yield* Effect.gen(function* () {
        const store = yield* SideChatStore.SideChatStore;
        const listed = store.has(SIDE_CHAT);
        yield* store.remove(SIDE_CHAT);
        return listed;
      }).pipe(Effect.provide(storeAt(baseDir)));
      assert.isTrue(afterRestart);

      const afterRemoval = yield* SideChatStore.SideChatStore.pipe(
        Effect.map((store) => store.has(SIDE_CHAT)),
        Effect.provide(storeAt(baseDir)),
      );
      assert.isFalse(afterRemoval);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts empty from an unreadable list instead of failing the server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cody-side-chat-store-" });
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      yield* fs.writeFileString(path.join(config.stateDir, "cody-side-chats.json"), "{not json");

      const listed = yield* SideChatStore.SideChatStore.pipe(
        Effect.flatMap((store) => store.list),
        Effect.provide(storeAt(baseDir)),
      );
      assert.deepEqual(listed, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports no side chats where the store is not provided", () =>
    Effect.gen(function* () {
      const membership = yield* SideChatStore.SideChatMembership;
      assert.isFalse(membership.isSideChat(SIDE_CHAT));
    }),
  );
});
