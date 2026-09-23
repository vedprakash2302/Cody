import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

it.effect.each([
  { kind: "numstat", elapsedMs: 45_000, succeeds: true },
  { kind: "numstat", elapsedMs: 120_000, succeeds: false },
  { kind: "patch", elapsedMs: 30_000, succeeds: false },
  { kind: "status", elapsedMs: 30_000, succeeds: false },
] as const)(
  "checkpoint summary timeout: $kind after $elapsedMs ms, succeeds=$succeeds",
  ({ kind, elapsedMs, succeeds }) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
          yield* Deferred.succeed(started, undefined);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromEffect(
              Deferred.await(finish).pipe(
                Effect.as(new TextEncoder().encode("12\t3\tfirst.ts\x007\t2\tlast.ts\0")),
              ),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const layer = VcsProcess.layer.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(Effect.provide(layer));
      const operation =
        kind === "status"
          ? driver
              .execute({ operation: "test.status", cwd: "/repo", args: ["status"] })
              .pipe(Effect.map((result) => result.stdout))
          : driver.checkpoints.diffCheckpoints({
              cwd: "/repo",
              fromCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/test/turn/0"),
              toCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/test/turn/1"),
              ignoreWhitespace: false,
              format: kind,
            });
      const fiber = yield* operation.pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(elapsedMs);
      if (succeeds) yield* Deferred.succeed(finish, undefined);
      const result = yield* Fiber.join(fiber);
      yield* Deferred.await(stopped);

      if (succeeds) {
        assert(result._tag === "Success");
        assert.deepEqual(parseTurnDiffFilesFromNumstat(result.success), [
          { path: "first.ts", additions: 12, deletions: 3 },
          { path: "last.ts", additions: 7, deletions: 2 },
        ]);
      } else {
        assert(result._tag === "Failure");
        assert(result.failure._tag === "VcsProcessTimeoutError");
        assert.strictEqual(result.failure.timeoutMs, elapsedMs);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
