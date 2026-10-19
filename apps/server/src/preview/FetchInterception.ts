import type { CDPSession } from "playwright-core";

interface FetchPattern {
  readonly urlPattern: string;
  readonly resourceType: "Document";
  readonly requestStage: "Request" | "Response";
}

const enabledPatterns = new WeakMap<CDPSession, ReadonlyArray<FetchPattern>>();

/**
 * Fetch.enable replaces a session's patterns, so a second interceptor on the
 * same tab would silently switch the first one off. Each one adds its patterns
 * to those already enabled instead.
 */
export async function enableFetchPatterns(
  cdp: CDPSession,
  patterns: ReadonlyArray<FetchPattern>,
): Promise<void> {
  const next = [...(enabledPatterns.get(cdp) ?? []), ...patterns];
  enabledPatterns.set(cdp, next);
  await cdp.send("Fetch.enable", { patterns: next });
}

/**
 * Every Fetch.requestPaused listener on a session sees every paused request.
 * Interceptors pause at different stages, so each answers only its own stage
 * and leaves the rest to the interceptor that asked for them.
 */
export const isResponseStage = (event: {
  readonly responseStatusCode?: number;
  readonly responseErrorReason?: string;
}) => event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
