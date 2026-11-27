import type { CDPSession } from "playwright-core";

interface FetchPattern {
  readonly urlPattern: string;
  readonly resourceType: "Document";
  readonly requestStage: "Request" | "Response";
}

interface FetchState {
  readonly patterns: ReadonlyArray<FetchPattern>;
  readonly handleAuthRequests: boolean;
}

const enabledFetch = new WeakMap<CDPSession, FetchState>();
const requestStageOwners = new WeakSet<CDPSession>();

/**
 * Fetch.enable replaces a session's patterns, so a second interceptor on the
 * same tab would silently switch the first one off. Each one adds its patterns
 * to those already enabled instead, and HTTP auth handling stays on once asked for.
 */
export async function enableFetchPatterns(
  cdp: CDPSession,
  patterns: ReadonlyArray<FetchPattern>,
  options: { readonly handleAuthRequests?: boolean } = {},
): Promise<void> {
  const current = enabledFetch.get(cdp);
  const next: FetchState = {
    patterns: [...(current?.patterns ?? []), ...patterns],
    handleAuthRequests:
      (current?.handleAuthRequests ?? false) || options.handleAuthRequests === true,
  };
  enabledFetch.set(cdp, next);
  await cdp.send("Fetch.enable", {
    patterns: [...next.patterns],
    ...(next.handleAuthRequests ? { handleAuthRequests: true } : {}),
  });
}

/**
 * A request paused before it is sent can be continued only once, so one
 * interceptor answers every such pause on a tab: the one that rewrites them.
 */
export function takeRequestStage(cdp: CDPSession): void {
  requestStageOwners.add(cdp);
}

export const requestStageTaken = (cdp: CDPSession) => requestStageOwners.has(cdp);

/**
 * Every Fetch.requestPaused listener on a session sees every paused request.
 * Interceptors pause at different stages, so each answers only its own stage
 * and leaves the rest to the interceptor that asked for them.
 */
export const isResponseStage = (event: {
  readonly responseStatusCode?: number;
  readonly responseErrorReason?: string;
}) => event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
