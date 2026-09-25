import { SubagentTranscriptError, type SubagentTranscriptInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderServiceShape } from "./Services/ProviderService.ts";

/**
 * Serves `provider.readSubagentTranscript`: routes to the thread's adapter and
 * maps provider failures to the transcript failure reasons clients show.
 */
export const readSubagentTranscriptRpc = (
  providerService: ProviderServiceShape,
  input: SubagentTranscriptInput,
) => {
  const read = providerService.readSubagentTranscript;
  if (read === undefined) {
    return Effect.fail(new SubagentTranscriptError({ reason: "unsupported" }));
  }
  return read(input).pipe(
    Effect.mapError((cause) => {
      switch (cause._tag) {
        case "ProviderUnsupportedError":
          return new SubagentTranscriptError({ reason: "unsupported", cause });
        // No binding for the thread, or the task is not one of its subagents.
        case "ProviderValidationError":
        case "ProviderAdapterValidationError":
          return new SubagentTranscriptError({ reason: "not-found", cause });
        // Reading never restarts a stopped session.
        case "ProviderSessionNotFoundError":
        case "ProviderAdapterSessionNotFoundError":
          return new SubagentTranscriptError({ reason: "session-inactive", cause });
        default:
          return new SubagentTranscriptError({ reason: "unavailable", cause });
      }
    }),
  );
};
