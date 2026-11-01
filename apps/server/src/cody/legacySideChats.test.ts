import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { archiveLegacySideChats } from "./legacySideChats.ts";

const shell = (id: string, overrides: Record<string, unknown> = {}) => ({
  id: ThreadId.make(id),
  deletedAt: null,
  archivedAt: null,
  lineage: { parentThreadId: ThreadId.make("parent") },
  ...overrides,
});

const shells: Record<string, ReturnType<typeof shell> | null> = {
  open: shell("open"),
  closed: shell("closed", { archivedAt: "2026-10-30T00:00:00Z" }),
  deleted: shell("deleted", { deletedAt: "2026-10-30T00:00:00Z" }),
  upstream: shell("upstream", { lineage: { parentThreadId: "parent", sideChat: true } }),
  gone: null,
};

const run = (options: { readonly failArchive?: boolean } = {}) =>
  Effect.gen(function* () {
    const archived: Array<string> = [];
    const removed: Array<string> = [];
    yield* archiveLegacySideChats().pipe(
      Effect.provide(
        Layer.mergeAll(
          Path.layer,
          Layer.mock(ServerConfig.ServerConfig)({
            stateDir: "/state",
          } as ServerConfig.ServerConfig["Service"]),
          FileSystem.layerNoop({
            exists: () => Effect.succeed(true),
            readFileString: () =>
              Effect.succeed(JSON.stringify({ version: 1, threadIds: Object.keys(shells) })),
            remove: (path) => Effect.sync(() => void removed.push(path)),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) => Effect.succeed((shells[threadId] ?? null) as never),
            dispatch: (command) =>
              options.failArchive
                ? Effect.die("archive refused")
                : Effect.sync(() => {
                    if (command.type === "thread.archive") archived.push(command.threadId);
                    return {} as never;
                  }),
          }),
        ),
      ),
    );
    return { archived, removed };
  });

describe("archiveLegacySideChats", () => {
  it.effect("archives Cody's old open side chats, then drops the list", () =>
    Effect.gen(function* () {
      const { archived, removed } = yield* run();
      assert.deepEqual(archived, ["open"]);
      assert.deepEqual(removed, ["/state/cody-side-chats.json"]);
    }),
  );

  it.effect("keeps the list for the next start when an archive fails", () =>
    Effect.gen(function* () {
      const { removed } = yield* run({ failArchive: true });
      assert.deepEqual(removed, []);
    }),
  );
});
