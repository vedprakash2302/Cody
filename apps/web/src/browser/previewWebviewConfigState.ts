import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopPreviewBridge,
  DesktopPreviewWebviewConfig,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewTunnel } from "~/state/previewTunnel";

const PREVIEW_CONFIG_STALE_TIME_MS = 5 * 60_000;
const PREVIEW_CONFIG_IDLE_TTL_MS = 10 * 60_000;

export class PreviewWebviewBridgeUnavailableError extends Schema.TaggedError<PreviewWebviewBridgeUnavailableError>()(
  "PreviewWebviewBridgeUnavailableError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Desktop preview configuration is unavailable for environment "${this.environmentId}".`;
  }
}

export class PreviewWebviewConfigLoadError extends Schema.TaggedError<PreviewWebviewConfigLoadError>()(
  "PreviewWebviewConfigLoadError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load desktop preview configuration for environment "${this.environmentId}".`;
  }
}

export const PreviewWebviewConfigError = Schema.Union([
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
]);
export type PreviewWebviewConfigError = typeof PreviewWebviewConfigError.Type;

type PreviewConfigBridge = Pick<DesktopPreviewBridge, "getPreviewConfig">;

export const loadPreviewWebviewConfig = (
  environmentId: EnvironmentId,
  profileId?: string,
  bridge: PreviewConfigBridge | null = previewBridge,
  tunnel = false,
): Effect.Effect<DesktopPreviewWebviewConfig, PreviewWebviewConfigError> => {
  if (bridge === null) {
    return Effect.fail(new PreviewWebviewBridgeUnavailableError({ environmentId }));
  }

  return Effect.tryPromise({
    try: () => bridge.getPreviewConfig(environmentId, profileId, { tunnel }),
    catch: (cause) => new PreviewWebviewConfigLoadError({ environmentId, cause }),
  });
};

/**
 * `Atom.family` keys on its argument, so the tunnel flag, environment, and
 * profile are folded into one string: passing an object would allocate a
 * fresh entry on every render. The flag leads because it is one character
 * and cannot contain the delimiter.
 *
 * The profile is the tail rather than a second field, so an id containing the
 * delimiter round-trips whole instead of being truncated into a different
 * profile's key. `BrowserProfileId` rejects control characters, which is what
 * makes the environment side of the split unambiguous.
 */
const CONFIG_KEY_DELIMITER = "\u0000";

const configKey = (
  environmentId: EnvironmentId,
  profileId: string | undefined,
  tunnel: boolean,
): string => `${tunnel ? "1" : "0"}${environmentId}${CONFIG_KEY_DELIMITER}${profileId ?? ""}`;

const parseConfigKey = (
  key: string,
): { environmentId: EnvironmentId; profileId?: string; tunnel: boolean } => {
  const rest = key.slice(1);
  const delimiter = rest.indexOf(CONFIG_KEY_DELIMITER);
  const environmentId = (delimiter === -1 ? rest : rest.slice(0, delimiter)) as EnvironmentId;
  const profileId = delimiter === -1 ? "" : rest.slice(delimiter + CONFIG_KEY_DELIMITER.length);
  return {
    environmentId,
    ...(profileId === "" ? {} : { profileId }),
    tunnel: key.startsWith("1"),
  };
};

const previewWebviewConfigAtom = Atom.family((key: string) => {
  const { environmentId, profileId, tunnel } = parseConfigKey(key);
  return Atom.make(loadPreviewWebviewConfig(environmentId, profileId, previewBridge, tunnel)).pipe(
    Atom.swr({
      staleTime: PREVIEW_CONFIG_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PREVIEW_CONFIG_IDLE_TTL_MS),
    Atom.withLabel(`preview:webview-config:${key}`),
  );
});

const PENDING_CONFIG_ATOM = Atom.make(
  AsyncResult.initial<DesktopPreviewWebviewConfig, PreviewWebviewConfigError>(),
).pipe(Atom.withLabel("preview:webview-config:pending"));

export function usePreviewWebviewConfig(
  environmentId: EnvironmentId,
  profileId?: string,
): DesktopPreviewWebviewConfig | null {
  const tunnel = usePreviewTunnel(environmentId);
  // Until the route is known the webview stays unmounted, so it never loads
  // a page on the wrong machine first.
  const result = useAtomValue(
    tunnel === undefined
      ? PENDING_CONFIG_ATOM
      : previewWebviewConfigAtom(configKey(environmentId, profileId, tunnel)),
  );
  return Option.getOrNull(AsyncResult.value(result));
}
