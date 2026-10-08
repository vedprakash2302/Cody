import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "../../pairingUrl";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

/**
 * Pairing link on the page's own origin. Null for the desktop app's private
 * scheme (`t3code://app`), which no other device can open.
 */
export function resolveOriginPairingUrl(pageUrl: string, credential: string): string | null {
  const url = new URL("/pair", pageUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
