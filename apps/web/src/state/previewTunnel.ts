/**
 * Whether the desktop Browser panel reaches an environment's dev servers
 * through its preview tunnel, and the credentials the tunnel needs.
 *
 * `localhost` in a preview tab means the machine the environment runs on.
 * The desktop's own backends (its primary and its local WSL backends) share
 * this machine, so their tabs load directly as they always have. Every other
 * environment gets its loopback traffic proxied over the environment's
 * `/api/preview-tunnel`, which rides whatever connection already reaches that
 * server: LAN, Tailscale, SSH, or T3 Connect. A remote environment tunnels
 * even when its URL is loopback, because an SSH forward or a port forward
 * into WSL makes a remote server look local.
 *
 * The answer only uses facts that survive a reconnect: the environment's
 * connection target and its server's capability. Remote targets always
 * authenticate with a bearer or DPoP token, which the ticket needs.
 */
import { useAtomValue } from "@effect/atom-react";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  type DeviceHubAccess,
  resolveEnvironmentSocketAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { connectionAtomRuntime } from "~/connection/runtime";
import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";
import { environmentSession } from "~/state/session";

export const PREVIEW_TUNNEL_PATH = "/api/preview-tunnel";

/** Tickets live five minutes; refresh with room for a slow round trip. */
const CREDENTIAL_REFRESH_MS = 4 * 60_000;

/**
 * `undefined` while the answer is unknown: the catalog has not loaded, or a
 * remote server has not reported its capabilities yet. Callers hold the
 * webview until it is known so a tab never starts on the wrong machine.
 */
export function shouldTunnelPreview(input: {
  readonly isElectron: boolean;
  /** `undefined` until the catalog loads; `null` when it has no entry. */
  readonly target: ConnectionTarget | null | undefined;
  /** `undefined` until the server's capabilities arrive. */
  readonly serverSupportsTunnel: boolean | undefined;
}): boolean | undefined {
  if (!input.isElectron) return false;
  if (input.target === undefined) return undefined;
  if (input.target === null) return false;
  if (
    input.target._tag === "PrimaryConnectionTarget" ||
    isDesktopLocalConnectionTarget(input.target)
  ) {
    return false;
  }
  return input.serverSupportsTunnel;
}

const previewTunnelAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): boolean | undefined => {
    const catalog = get(environmentCatalog.catalogValueAtom);
    const capabilities = get(environmentServerConfigsAtom).get(environmentId)?.environment
      .capabilities;
    const decision = shouldTunnelPreview({
      isElectron,
      target: catalog.isReady ? (catalog.entries.get(environmentId)?.target ?? null) : undefined,
      serverSupportsTunnel:
        capabilities === undefined ? undefined : capabilities.previewTunnel === true,
    });
    // A reconnect briefly drops the server's config; keep the settled answer
    // rather than flipping open tabs to the other machine.
    return decision ?? Option.getOrUndefined(get.self<boolean | undefined>());
  }).pipe(Atom.keepAlive, Atom.withLabel(`preview-tunnel:${environmentId}`)),
);

export function usePreviewTunnel(environmentId: EnvironmentId): boolean | undefined {
  return useAtomValue(previewTunnelAtom(environmentId));
}

export function readPreviewTunnel(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(previewTunnelAtom(environmentId)) === true;
}

const previewTunnelAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveEnvironmentSocketAccess({ prepared, basePath: PREVIEW_TUNNEL_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`preview-tunnel-access:${environmentId}`)),
);

const NO_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubAccess, never>()).pipe(
  Atom.withLabel("preview-tunnel-access:none"),
);

/**
 * Keeps the desktop's tunnel credentials for one environment current while
 * its tabs are mounted. A re-pair changes the prepared connection, which
 * mints a new ticket through the access atom.
 */
export function usePreviewTunnelCredentials(environmentId: EnvironmentId, enabled: boolean): void {
  const result = useAtomValue(enabled ? previewTunnelAccessAtom(environmentId) : NO_ACCESS_ATOM);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!enabled || preview === undefined || !AsyncResult.isSuccess(result)) return;
    const wsTicket = result.value.query.wsTicket;
    if (wsTicket === undefined) return;
    void preview
      .setTunnelCredentials(environmentId, { tunnelUrl: result.value.wsBase, wsTicket })
      .catch(() => undefined);
  }, [enabled, environmentId, result]);

  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(
      () => appAtomRegistry.refresh(previewTunnelAccessAtom(environmentId)),
      CREDENTIAL_REFRESH_MS,
    );
    return () => window.clearInterval(interval);
  }, [enabled, environmentId]);
}
