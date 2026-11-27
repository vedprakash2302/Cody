/**
 * Windows work-account sign-in for headless tabs on a WSL host. CDP Fetch pauses each Entra
 * redirect hop on its own, unlike Playwright's route API, so only Entra hops get the host's
 * device proofs (the headers Edge sends on Windows).
 */
import {
  isWindowsSsoUrl,
  readWindowsSsoAuth,
  type WindowsSsoAuth,
} from "@t3tools/shared/windowsSso";
import type { CDPSession } from "playwright-core";

import { enableFetchPatterns, isResponseStage, takeRequestStage } from "./FetchInterception.ts";

interface PausedRequest {
  readonly requestId: string;
  readonly request: { readonly url: string; readonly headers: Record<string, string> };
  readonly responseStatusCode?: number;
  readonly responseErrorReason?: string;
}

/** Helper processes a host runs at once; more sign-in hops continue without a proof. */
const MAX_CONCURRENT_HELPERS = 4;

/**
 * The request's headers with the proofs added, or undefined to leave it unchanged.
 * Windows returns its proofs as x-ms-* records; any other record would be a
 * cookie, which Fetch can't add next to the browser's own, so it is skipped.
 */
export function withWindowsSsoProof(
  headers: Record<string, string>,
  auth: WindowsSsoAuth,
): Array<{ readonly name: string; readonly value: string }> | undefined {
  const proofs = Object.entries(auth.headers);
  if (proofs.length === 0) return undefined;
  const replaced = new Set(proofs.map(([name]) => name.toLowerCase()));
  return [
    ...Object.entries(headers)
      .filter(([name]) => !replaced.has(name.toLowerCase()))
      .map(([name, value]) => ({ name, value })),
    ...proofs.map(([name, value]) => ({ name, value })),
  ];
}

export function makeWindowsSso(readAuth: (url: string) => Promise<WindowsSsoAuth>): {
  readonly install: (cdp: CDPSession) => Promise<void>;
} {
  let active = 0;
  const proofHeaders = async (event: PausedRequest) => {
    if (!isWindowsSsoUrl(event.request.url) || active >= MAX_CONCURRENT_HELPERS) return undefined;
    active++;
    try {
      return withWindowsSsoProof(event.request.headers, await readAuth(event.request.url));
    } catch {
      // No work account, a timeout, or a helper Windows can't run: normal interactive sign-in.
      return undefined;
    } finally {
      active--;
    }
  };
  return {
    install: async (cdp) => {
      takeRequestStage(cdp);
      cdp.on("Fetch.requestPaused", (event: PausedRequest) => {
        if (isResponseStage(event)) return;
        void proofHeaders(event).then((headers) =>
          cdp
            .send("Fetch.continueRequest", {
              requestId: event.requestId,
              ...(headers ? { headers } : {}),
            })
            .catch(() => undefined),
        );
      });
      await enableFetchPatterns(cdp, [
        {
          urlPattern: "https://login.microsoftonline.com/*",
          resourceType: "Document",
          requestStage: "Request",
        },
      ]);
    },
  };
}

/** Sign-in for a host whose desktop app enabled it, or undefined. */
export function windowsSsoFromEnv(
  helper: string | undefined,
): ReturnType<typeof makeWindowsSso> | undefined {
  return helper ? makeWindowsSso((url) => readWindowsSsoAuth(helper, url)) : undefined;
}
