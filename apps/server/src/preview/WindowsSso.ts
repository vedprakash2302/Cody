/**
 * Windows work-account sign-in for headless tabs on a WSL host. The desktop app
 * passes the path of its Windows helper, and each Entra sign-in navigation gets
 * the host's device proofs, the same headers Edge sends on Windows.
 *
 * Playwright's route API can't do this: it re-applies a continued request's
 * headers to every redirect hop and never routes the hops. CDP Fetch pauses
 * each hop, and continueRequest headers apply to that hop only, so a redirect
 * away from Entra never carries a proof.
 */
import {
  isWindowsSsoUrl,
  readWindowsSsoAuth,
  type WindowsSsoAuth,
} from "@t3tools/shared/windowsSso";
import type { CDPSession } from "playwright-core";

interface PausedRequest {
  readonly requestId: string;
  readonly request: { readonly url: string; readonly headers: Record<string, string> };
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
      cdp.on("Fetch.requestPaused", (event: PausedRequest) => {
        void proofHeaders(event).then((headers) =>
          cdp
            .send("Fetch.continueRequest", {
              requestId: event.requestId,
              ...(headers ? { headers } : {}),
            })
            .catch(() => undefined),
        );
      });
      await cdp.send("Fetch.enable", {
        patterns: [
          {
            urlPattern: "https://login.microsoftonline.com/*",
            resourceType: "Document",
            requestStage: "Request",
          },
        ],
      });
    },
  };
}

/** Sign-in for a host whose desktop app enabled it, or undefined. */
export function windowsSsoFromEnv(
  helper: string | undefined,
): ReturnType<typeof makeWindowsSso> | undefined {
  return helper ? makeWindowsSso((url) => readWindowsSsoAuth(helper, url)) : undefined;
}
