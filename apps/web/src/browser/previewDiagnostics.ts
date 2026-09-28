import * as Effect from "effect/Effect";

import * as ClientTracer from "~/observability/clientTracer";

/**
 * Records a preview webview losing its page as a `web.preview.<event>` span.
 * Client spans are exported to the primary environment's server, so they land
 * in that server's `server.trace.ndjson` next to the desktop's own
 * "Preview tab lost its guest." entries in `desktop.trace.ndjson`.
 */
export function reportPreviewWebviewEvent(
  event: "guestDestroyed" | "webviewWithdrawn",
  attributes: Readonly<Record<string, string | number | boolean>>,
): void {
  Effect.runFork(
    Effect.logWarning(`Preview webview ${event}`, attributes).pipe(
      Effect.withSpan(`web.preview.${event}`, { attributes }),
      Effect.provide(ClientTracer.layer),
    ),
  );
}
