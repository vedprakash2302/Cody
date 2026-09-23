/**
 * Whether the desktop Browser panel reaches an environment's dev servers
 * through its preview tunnel, and the credentials the tunnel needs.
 *
 * `localhost` in a preview tab means the machine the environment runs on.
 * Only a desktop-managed backend reached over loopback shares this machine's
 * `localhost`, so only its tabs load directly. Every other environment,
 * including a desktop-managed WSL backend on its NAT address, gets its
 * loopback traffic proxied over the environment's `/api/preview-tunnel`,
 * which rides whatever connection already reaches that server: LAN,
 * Tailscale, SSH, or T3 Connect. A remote environment tunnels even when its
 * URL is loopback, because an SSH forward or a port forward into WSL makes a
 * remote server look local.
 */
import { useAtomValue } from "@effect/atom-react";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  type DeviceHubAccess,
  resolveEnvironmentSocketAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
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

export function shouldTunnelPreview(input: {
  readonly isElectron: boolean;
  readonly target: ConnectionTarget | null;
  /** The URL this client uses to reach the environment. */
  readonly httpBaseUrl: string | null;
  readonly serverSupportsTunnel: boolean;
  /** Cookie sessions have no ticket to hand the desktop's main process. */
  readonly hasAuthorization: boolean;
}): boolean {
  if (!input.isElectron || input.target === null) return false;
  if (!input.serverSupportsTunnel || !input.hasAuthorization) return false;
  const desktopManaged =
    input.target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(input.target);
  if (!desktopManaged) return true;
  // A desktop-managed backend in WSL (NAT networking) has its own loopback,
  // which the WSL address cannot reach from here.
  return !isOnThisMachinesLoopback(input.httpBaseUrl);
}

function isOnThisMachinesLoopback(httpBaseUrl: string | null): boolean {
  if (httpBaseUrl === null) return false;
  try {
    return isLocalLoopbackHost(new URL(httpBaseUrl).hostname);
  } catch {
    return false;
  }
}

const previewTunnelAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    return shouldTunnelPreview({
      isElectron,
      target: get(environmentCatalog.catalogValueAtom).entries.get(environmentId)?.target ?? null,
      httpBaseUrl: prepared?.httpBaseUrl ?? null,
      serverSupportsTunnel:
        get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
          .previewTunnel === true,
      hasAuthorization: prepared !== null && prepared.httpAuthorization !== null,
    });
  }).pipe(Atom.withLabel(`preview-tunnel:${environmentId}`)),
);

export function usePreviewTunnel(environmentId: EnvironmentId): boolean {
  return useAtomValue(previewTunnelAtom(environmentId));
}

export function readPreviewTunnel(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(previewTunnelAtom(environmentId));
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
