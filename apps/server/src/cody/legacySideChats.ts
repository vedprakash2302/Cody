import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

/** Cody's own side chat list, from before Cody used upstream's side chats. */
const LEGACY_SIDE_CHATS_FILE = "cody-side-chats.json";

const decodeLegacyFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ threadIds: Schema.Array(ThreadId) })),
);

/**
 * Archives the side chats Cody kept before it used upstream's. Upstream sees
 * them as ordinary forks, so they would otherwise show in the sidebar. The
 * list is removed once every one is archived, and retried on the next start.
 */
export const archiveLegacySideChats = Effect.fn("Cody.archiveLegacySideChats")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const filePath = path.join(config.stateDir, LEGACY_SIDE_CHATS_FILE);
  if (!(yield* fileSystem.exists(filePath))) return;
  const { threadIds } = yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.flatMap(decodeLegacyFile));
  const results = yield* Effect.forEach(threadIds, (threadId) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(threadId);
      if (
        shell === null ||
        shell.deletedAt !== null ||
        shell.archivedAt !== null ||
        shell.lineage.sideChat === true
      ) {
        return;
      }
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`cody:legacy-side-chat:archive:${threadId}`),
        threadId,
      });
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("Couldn't archive an old Cody side chat.", { threadId, cause }).pipe(
          Effect.as(false),
        ),
      ),
    ),
  );
  if (results.every(Boolean)) yield* fileSystem.remove(filePath);
});

/** Runs the archive after the server activates, so startup never waits on it. */
export const archiveLegacySideChatsOnStart = forkParked(
  archiveLegacySideChats().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Couldn't archive Cody's old side chats.", cause),
    ),
  ),
);
