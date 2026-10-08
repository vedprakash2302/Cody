import {
  type AdvertisedEndpoint,
  type AdvertisedEndpointProvider,
  type AuthGrantScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type DesktopBridge,
  type DesktopWslState,
  type ServerDirectEndpoint,
} from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";

/**
 * Operating terminals without being able to list them leaves a client
 * allocating a fresh shell for every script run it cannot see, so the pairing
 * form keeps `terminal:read` alongside `terminal:operate`.
 */
export function togglePairingScopeSelection(
  current: ReadonlyArray<AuthGrantScope>,
  scope: AuthGrantScope,
  checked: boolean,
): ReadonlyArray<AuthGrantScope> {
  const without = (scopes: ReadonlyArray<AuthGrantScope>) =>
    scopes.filter((currentScope) => currentScope !== scope);
  if (!checked) {
    return scope === AuthTerminalReadScope
      ? without(current).filter((currentScope) => currentScope !== AuthTerminalOperateScope)
      : without(current);
  }
  const next = [...without(current), scope];
  return scope === AuthTerminalOperateScope && !next.includes(AuthTerminalReadScope)
    ? [...next, AuthTerminalReadScope]
    : next;
}

/** A missing access list says nothing about whether other clients exist. */
export function canRevokeOtherClients(
  clientSessions: ReadonlyArray<{ readonly current: boolean }> | null,
): boolean {
  return clientSessions === null || clientSessions.some((session) => !session.current);
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/**
 * A QR code encoding a loopback URL makes the scanning device dial itself, so
 * loopback endpoints stay copyable from the endpoint menu but are never
 * offered as QR targets.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

const SERVER_TAILNET_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

/**
 * Adds the tailnet addresses the backend reports listening on to the desktop's
 * own list. The desktop only sees its own machine's network, which misses a
 * WSL backend: that binds every interface inside the distro, and a distro
 * running Tailscale is its own tailnet node. HTTPS names are left to the
 * desktop's Tailscale Serve row.
 */
export function withServerTailnetEndpoints(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  directEndpoints: ReadonlyArray<ServerDirectEndpoint> | undefined,
): ReadonlyArray<AdvertisedEndpoint> {
  const listed = new Set(endpoints.map((endpoint) => endpoint.httpBaseUrl));
  const added: AdvertisedEndpoint[] = [];
  for (const directEndpoint of directEndpoints ?? []) {
    if (directEndpoint.kind !== "tailnet") continue;
    let endpoint: AdvertisedEndpoint;
    try {
      endpoint = createAdvertisedEndpoint({
        provider: SERVER_TAILNET_ENDPOINT_PROVIDER,
        source: "desktop-addon",
        id: `tailscale-ip:${directEndpoint.httpBaseUrl}`,
        label: "Tailscale IP",
        httpBaseUrl: directEndpoint.httpBaseUrl,
        reachability: "private-network",
        status: "available",
        description: "Reachable from devices on the same Tailnet.",
      });
    } catch {
      continue;
    }
    if (new URL(endpoint.httpBaseUrl).protocol !== "http:" || listed.has(endpoint.httpBaseUrl)) {
      continue;
    }
    listed.add(endpoint.httpBaseUrl);
    added.push(endpoint);
  }
  return added.length === 0 ? endpoints : [...endpoints, ...added];
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

export type QrEndpointOption = {
  /** Unique per endpoint instance (AdvertisedEndpoint.id); safe as a React key. */
  readonly id: string;
  /**
   * Stable per endpoint *type* (endpointDefaultPreferenceKey). Multiple
   * endpoints can share one, so it is only used to match the saved default.
   */
  readonly preferenceKey: string;
  /** False for endpoints that stay copyable but must never render as a QR. */
  readonly qrShareable: boolean;
};

/**
 * Resolves which endpoint the share panel shows: the user's explicit pick,
 * else the saved default endpoint, else the first QR-shareable option (so the
 * panel never opens on a loopback QR), else the first option. A stale
 * selectedId (endpoint disappeared) falls back rather than blanking the panel.
 */
export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
