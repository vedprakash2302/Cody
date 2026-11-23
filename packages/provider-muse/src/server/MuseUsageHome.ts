import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import { createMuseSdkHostEffect, MuseSdkError } from "./sdk.ts";

export class MuseUsageHome extends Context.Service<
  MuseUsageHome,
  {
    /** None while discovery is still running and `awaitRefresh` is false. */
    readonly resolve: (input: {
      readonly binaryPath: string;
      readonly environment: NodeJS.ProcessEnv;
      readonly awaitRefresh: boolean;
    }) => Effect.Effect<Option.Option<string | undefined>>;
  }
>()("@t3tools/provider-muse/server/MuseUsageHome") {}

/** How long a CLI that is not installed stays unsearched; PATH lookups on WSL stat Windows drives. */
const MISSING_EXECUTABLE_TTL = Duration.minutes(10);

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const missingUntil = new Map<string, number>();
  const cache = yield* Cache.makeWith(
    Effect.fn("MuseUsageHome.initialize")(function* (input: {
      readonly binaryPath: string;
      readonly environment: NodeJS.ProcessEnv;
    }) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Effect.acquireRelease(
            createMuseSdkHostEffect({ ...input, readOnly: true, startupTimeoutMs: 5_000 }),
            (host) =>
              Effect.tryPromise({
                try: () => host.close(),
                catch: (cause) => new MuseSdkError({ operation: "close", cause }),
              }).pipe(Effect.ignore),
            { interruptible: true },
          );
          return host.initializeResult.museHome;
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));
    }),
    {
      capacity: 32,
      // Retry unavailable installations, but keep resolved homes across scans.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value ? Duration.infinity : Duration.seconds(30),
    },
  );
  const resolve: MuseUsageHome["Service"]["resolve"] = Effect.fn("MuseUsageHome.resolve")(
    function* ({ binaryPath, environment, awaitRefresh }) {
      // Cache keys compare structurally. Omitted and undefined variables both
      // disappear from the child process environment and must share an entry.
      const key = {
        binaryPath,
        environment: Object.fromEntries(
          Object.entries(environment).filter(([, value]) => value !== undefined),
        ),
      };
      const settled = yield* Cache.getSuccess(cache, key);
      if (Option.isSome(settled)) return settled;
      const missingKey = [binaryPath, environment.PATH, environment.PATHEXT].join("\0");
      const now = yield* Clock.currentTimeMillis;
      if ((missingUntil.get(missingKey) ?? 0) > now) return Option.some(undefined);
      // Spawn failures surface asynchronously; without this a missing CLI would report as pending.
      const resolveExecutable = yield* SpawnExecutableResolution;
      const platform = yield* HostProcess.Platform;
      const resolved = yield* Effect.promise(async () =>
        resolveExecutable(binaryPath, platform, environment),
      );
      if (resolved === undefined) {
        missingUntil.set(missingKey, now + Duration.toMillis(MISSING_EXECUTABLE_TTL));
        return Option.some(undefined);
      }
      missingUntil.delete(missingKey);
      if (awaitRefresh) return Option.some(yield* Cache.get(cache, key));
      // Awaited in the layer scope so a departing caller cannot cancel discovery.
      yield* Effect.forkIn(Cache.get(cache, key), scope, { startImmediately: true });
      // A lookup that settled synchronously needs no refresh.
      return yield* Cache.getSuccess(cache, key);
    },
  );
  return MuseUsageHome.of({ resolve });
});

export const layer = Layer.effect(MuseUsageHome, make);
