import { RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { assert, describe, it } from "@effect/vitest";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderSessionNotFoundError,
  ProviderUnsupportedError,
} from "./Errors.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";
import { readSubagentTranscriptRpc } from "./subagentTranscriptRpc.ts";

const input = { threadId: ThreadId.make("thread-1"), taskId: RuntimeTaskId.make("ses_child") };
const failingWith = (
  error:
    | ProviderUnsupportedError
    | ProviderAdapterValidationError
    | ProviderSessionNotFoundError
    | ProviderAdapterRequestError,
): ProviderServiceShape =>
  ({ readSubagentTranscript: () => Effect.fail(error) }) as unknown as ProviderServiceShape;
const reasonFor = (service: ProviderServiceShape) =>
  readSubagentTranscriptRpc(service, input).pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("readSubagentTranscriptRpc", () => {
  it.effect("reports why a transcript cannot be shown", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonFor({} as ProviderServiceShape), "unsupported");
      assert.strictEqual(
        yield* reasonFor(failingWith(new ProviderUnsupportedError({ provider: "codex" }))),
        "unsupported",
      );
      assert.strictEqual(
        yield* reasonFor(
          failingWith(
            new ProviderAdapterValidationError({
              provider: "opencode",
              operation: "readSubagentTranscript",
              issue: "not a subagent",
            }),
          ),
        ),
        "not-found",
      );
      assert.strictEqual(
        yield* reasonFor(failingWith(new ProviderSessionNotFoundError({ threadId: "thread-1" }))),
        "session-inactive",
      );
      assert.strictEqual(
        yield* reasonFor(
          failingWith(
            new ProviderAdapterRequestError({
              provider: "opencode",
              method: "session.messages",
              detail: "timeout",
            }),
          ),
        ),
        "unavailable",
      );
    }),
  );
});
