import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type { DesktopBackendInstance } from "../backend/DesktopBackendManager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-auto-update");

/** Served by each backend; see apps/server/src/desktopUpdate/DesktopAgentActivity.ts. */
export const AGENT_ACTIVITY_PATH = "/api/desktop/agent-activity";
/** How long every backend must report idle before the app restarts into an update. */
export const AUTO_INSTALL_IDLE = Duration.minutes(5);
/**
 * A fresh download waits this long before an automatic install, so a remote
 * client's "update this machine" request can finish its own install handshake.
 */
export const DOWNLOAD_SETTLE = Duration.minutes(5);
const ACTIVITY_POLL_INTERVAL = Duration.minutes(1);
const PROBE_TIMEOUT = Duration.seconds(5);

const decodeAgentActivity = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ busy: Schema.Boolean }),
);

export type AutoUpdateStep = "download" | "install" | "wait";

export function nextAutoUpdateStep(input: {
  readonly enabled: boolean;
  readonly state: DesktopUpdateState;
  /** When every backend last started reporting idle, or null while any is busy or unknown. */
  readonly idleSinceMs: number | null;
  /** When the downloaded version finished downloading. */
  readonly downloadedAtMs: number | null;
  readonly nowMs: number;
  /** A version whose install already failed; it waits for the user. */
  readonly failedInstallVersion: string | null;
}): AutoUpdateStep {
  const { state, nowMs } = input;
  if (!input.enabled || !state.enabled) return "wait";
  // A failed download waits for the updater's next check to clear its error.
  if (state.status === "available" && state.errorContext === null) return "download";
  if (
    state.status === "downloaded" &&
    state.errorContext === null &&
    state.downloadedVersion !== null &&
    state.downloadedVersion !== input.failedInstallVersion &&
    input.idleSinceMs !== null &&
    nowMs - input.idleSinceMs >= Duration.toMillis(AUTO_INSTALL_IDLE) &&
    input.downloadedAtMs !== null &&
    nowMs - input.downloadedAtMs >= Duration.toMillis(DOWNLOAD_SETTLE)
  ) {
    return "install";
  }
  return "wait";
}

/**
 * Asks one backend whether an agent is working. A backend that is starting,
 * restarting, unreachable, or answers anything unexpected counts as busy.
 */
const probeBackend = (instance: DesktopBackendInstance) =>
  Effect.gen(function* () {
    const snapshot = yield* instance.snapshot;
    if (!snapshot.desiredRunning) return false;
    if (!snapshot.ready) return true;
    const config = yield* instance.currentConfig;
    if (Option.isNone(config)) return true;
    const token = config.value.bootstrap.desktopBootstrapToken;
    if (token === undefined) return true;
    const httpClient = yield* HttpClient.HttpClient;
    const activity = yield* httpClient
      .get(new URL(AGENT_ACTIVITY_PATH, config.value.httpBaseUrl), {
        headers: { authorization: `Bearer ${token}` },
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(decodeAgentActivity),
        Effect.timeout(PROBE_TIMEOUT),
      );
    return activity.busy;
  }).pipe(Effect.orElseSucceed(() => true));

/**
 * Downloads new versions as the updater finds them and restarts into one once
 * every backend, including WSL, has reported no agent work for
 * AUTO_INSTALL_IDLE. Checks again right before restarting. Off when the user
 * turns off automatic updates in Settings.
 */
export const listen: Effect.Effect<
  void,
  never,
  | DesktopUpdates.DesktopUpdates
  | DesktopBackendPool.DesktopBackendPool
  | DesktopAppSettings.DesktopAppSettings
  | HttpClient.HttpClient
  | Scope.Scope
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const httpClient = yield* HttpClient.HttpClient;

  const { latest, changes } = yield* updates.subscribe;
  const stateRef = yield* Ref.make(latest);
  const idleSinceRef = yield* Ref.make<number | null>(null);
  const downloadedRef = yield* Ref.make<{ version: string; atMs: number } | null>(null);
  const failedInstallVersionRef = yield* Ref.make<string | null>(null);
  // One evaluator at a time; a trigger that arrives mid-download collapses into one rerun.
  const triggers = yield* Queue.sliding<void>(1);
  const probeDueRef = yield* Ref.make(true);

  const anyBackendBusy = pool.list.pipe(
    Effect.flatMap((instances) =>
      Effect.forEach(instances, probeBackend, { concurrency: "unbounded" }),
    ),
    Effect.map((busy) => busy.some(Boolean)),
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );
  const refreshActivity = Effect.gen(function* () {
    const busy = yield* anyBackendBusy;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* Ref.update(idleSinceRef, (idleSince) => (busy ? null : (idleSince ?? nowMs)));
    return busy;
  });

  const recordState = (state: DesktopUpdateState) =>
    Effect.gen(function* () {
      yield* Ref.set(stateRef, state);
      const version = state.downloadedVersion;
      if (version === null) return;
      if (state.errorContext === "install") {
        yield* Ref.set(failedInstallVersionRef, version);
      }
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Ref.update(downloadedRef, (downloaded) =>
        downloaded?.version === version ? downloaded : { version, atMs: nowMs },
      );
    });

  const evaluate = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const step = nextAutoUpdateStep({
      enabled: (yield* desktopSettings.get).autoInstallUpdates,
      state,
      idleSinceMs: yield* Ref.get(idleSinceRef),
      downloadedAtMs: (yield* Ref.get(downloadedRef))?.atMs ?? null,
      nowMs: yield* Clock.currentTimeMillis,
      failedInstallVersion: yield* Ref.get(failedInstallVersionRef),
    });
    switch (step) {
      case "wait":
        return;
      case "download":
        yield* logInfo("downloading update automatically", { version: state.availableVersion });
        yield* updates.download;
        return;
      case "install": {
        // An agent may have started since the last poll.
        if (yield* refreshActivity) return;
        yield* logInfo("installing update while agents are idle", {
          version: state.downloadedVersion,
        });
        const result = yield* updates.install;
        if (result.accepted && result.state.errorContext === "install") {
          yield* Ref.set(failedInstallVersionRef, state.downloadedVersion);
          yield* logWarning("automatic install failed; leaving this version to the user", {
            version: state.downloadedVersion,
          });
        }
        return;
      }
    }
  });

  yield* Stream.fromQueue(triggers).pipe(
    Stream.runForEach(() =>
      Ref.getAndSet(probeDueRef, false).pipe(
        Effect.flatMap((probeDue) => (probeDue ? refreshActivity : Effect.void)),
        Effect.andThen(evaluate),
      ),
    ),
    Effect.forkScoped,
  );
  yield* recordState(latest);
  yield* Stream.runForEach(changes, (state) =>
    recordState(state).pipe(Effect.andThen(Queue.offer(triggers, undefined))),
  ).pipe(Effect.forkScoped);
  yield* Ref.set(probeDueRef, true).pipe(
    Effect.andThen(Queue.offer(triggers, undefined)),
    Effect.andThen(Effect.sleep(ACTIVITY_POLL_INTERVAL)),
    Effect.forever,
    Effect.forkScoped,
  );
});
