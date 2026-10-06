import type { DesktopUpdateState } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopAutoUpdate from "./DesktopAutoUpdate.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const TOKEN = "desktop-bootstrap-token";
const NEXT_VERSION = "0.0.46-nightly.20261006.33";

const baseState: DesktopUpdateState = {
  ...createInitialDesktopUpdateState(
    "0.0.46-nightly.20261005.32",
    { hostArch: "x64", appArch: "x64", runningUnderArm64Translation: false },
    "nightly",
  ),
  enabled: true,
  status: "up-to-date",
};
const availableState: DesktopUpdateState = {
  ...baseState,
  status: "available",
  availableVersion: NEXT_VERSION,
};
const downloadedState: DesktopUpdateState = {
  ...availableState,
  status: "downloaded",
  downloadedVersion: NEXT_VERSION,
};
const minutes = (count: number) => Duration.toMillis(Duration.minutes(count));

describe("nextAutoUpdateStep", () => {
  const step = (overrides: Partial<Parameters<typeof DesktopAutoUpdate.nextAutoUpdateStep>[0]>) =>
    DesktopAutoUpdate.nextAutoUpdateStep({
      enabled: true,
      state: downloadedState,
      idleSinceMs: 0,
      downloadedAtMs: 0,
      nowMs: minutes(5),
      failedInstallVersion: null,
      ...overrides,
    });

  it("downloads a newly available version, but not straight after a failed download", () => {
    assert.equal(step({ state: availableState, idleSinceMs: null }), "download");
    assert.equal(step({ state: { ...availableState, errorContext: "download" } }), "wait");
  });

  it("installs only after agents were idle and the download settled for five minutes", () => {
    assert.equal(step({}), "install");
    assert.equal(step({ idleSinceMs: null }), "wait");
    assert.equal(step({ idleSinceMs: 1 }), "wait");
    assert.equal(step({ downloadedAtMs: 1 }), "wait");
  });

  it("does nothing when turned off or when updates are unavailable", () => {
    assert.equal(step({ enabled: false }), "wait");
    assert.equal(step({ enabled: false, state: availableState }), "wait");
    assert.equal(step({ state: { ...downloadedState, enabled: false } }), "wait");
  });

  it("leaves a version whose install failed to the user", () => {
    assert.equal(step({ failedInstallVersion: NEXT_VERSION }), "wait");
    assert.equal(step({ state: { ...downloadedState, errorContext: "install" } }), "wait");
  });
});

type BackendAnswer = "idle" | "busy" | "unreachable";

interface FakeBackend {
  readonly id: string;
  readonly port: number;
  readonly answer: Ref.Ref<BackendAnswer>;
  readonly ready?: boolean;
}

const makeInstance = (backend: FakeBackend): DesktopBackendManager.DesktopBackendInstance => ({
  id: DesktopBackendManager.BackendInstanceId(backend.id),
  label: Effect.succeed(backend.id),
  start: Effect.void,
  stop: () => Effect.void,
  waitForReady: () => Effect.succeed(true),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: backend.ready ?? true,
    activePid: Option.some(1),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  currentConfig: Effect.succeed(
    Option.some({
      executablePath: "/electron",
      args: [],
      entryPath: "/server/bin.mjs",
      cwd: "/server",
      env: {},
      bootstrap: {
        mode: "desktop",
        noBrowser: true,
        port: backend.port,
        t3Home: "/tmp/cody",
        host: "127.0.0.1",
        desktopBootstrapToken: TOKEN,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      bootstrapDelivery: "fd3",
      extendEnv: true,
      httpBaseUrl: new URL(`http://127.0.0.1:${backend.port}`),
      captureOutput: true,
      preflightFailure: Option.none(),
    }),
  ),
});

/** Answers each backend's activity endpoint by port, and only with the launch token. */
const httpClientLayer = (backends: ReadonlyArray<FakeBackend>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const url = new URL(request.url);
        const backend = backends.find((candidate) => String(candidate.port) === url.port);
        if (
          backend === undefined ||
          url.pathname !== DesktopAutoUpdate.AGENT_ACTIVITY_PATH ||
          request.headers.authorization !== `Bearer ${TOKEN}`
        ) {
          return HttpClientResponse.fromWeb(request, new Response("Unauthorized", { status: 401 }));
        }
        const answer = yield* Ref.get(backend.answer);
        if (answer === "unreachable") {
          return yield* Effect.never;
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(answer === "busy" ? '{"busy":true}' : '{"busy":false}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const runListener = Effect.fn(function* (input: {
  readonly backends: ReadonlyArray<FakeBackend>;
  readonly settings?: DesktopAppSettings.DesktopSettings;
  readonly installFails?: boolean;
  readonly scenario: (counts: {
    readonly downloads: Ref.Ref<number>;
    readonly installs: Ref.Ref<number>;
    readonly state: SubscriptionRef.SubscriptionRef<DesktopUpdateState>;
  }) => Effect.Effect<void, never, DesktopAppSettings.DesktopAppSettings>;
}) {
  const state = yield* SubscriptionRef.make(availableState);
  const downloads = yield* Ref.make(0);
  const installs = yield* Ref.make(0);
  const quitting = yield* Ref.make(false);
  const unexpected = (name: string) => Effect.die(`unexpected ${name}`);
  const failedInstallState: DesktopUpdateState = { ...downloadedState, errorContext: "install" };

  const updatesLayer = Layer.succeed(
    DesktopUpdates.DesktopUpdates,
    DesktopUpdates.DesktopUpdates.of({
      getState: SubscriptionRef.get(state),
      isActionActive: Effect.succeed(false),
      isInstallActive: Effect.succeed(false),
      subscribe: SubscriptionRef.get(state).pipe(
        Effect.map((latest) => ({ latest, changes: SubscriptionRef.changes(state) })),
      ),
      emitState: Effect.void,
      disabledReason: Effect.succeedNone,
      configure: unexpected("configure"),
      setChannel: () => unexpected("setChannel"),
      check: () => unexpected("check"),
      download: Ref.update(downloads, (count) => count + 1).pipe(
        Effect.andThen(SubscriptionRef.set(state, downloadedState)),
        Effect.as({ accepted: true, completed: true, state: downloadedState }),
      ),
      // Like the real updater, a successful install starts quitting and refuses another.
      install: Effect.gen(function* () {
        if (yield* Ref.get(quitting)) {
          return { accepted: false, completed: false, state: downloadedState };
        }
        yield* Ref.update(installs, (count) => count + 1);
        if (input.installFails) {
          yield* SubscriptionRef.set(state, failedInstallState);
          return { accepted: true, completed: false, state: failedInstallState };
        }
        yield* Ref.set(quitting, true);
        return { accepted: true, completed: false, state: downloadedState };
      }),
      installPrepared: () => unexpected("installPrepared"),
    }),
  );

  yield* Effect.gen(function* () {
    yield* DesktopAutoUpdate.listen;
    yield* input.scenario({ downloads, installs, state });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        updatesLayer,
        DesktopBackendPool.layerTest(input.backends.map(makeInstance)),
        DesktopAppSettings.layerTest(input.settings),
        httpClientLayer(input.backends),
      ),
    ),
  );
});

describe("DesktopAutoUpdate.listen", () => {
  it.effect("waits for every backend, including WSL, to stay idle before installing", () =>
    Effect.gen(function* () {
      const primary = { id: "local", port: 3773, answer: yield* Ref.make<BackendAnswer>("idle") };
      const wsl = { id: "wsl:ubuntu", port: 4773, answer: yield* Ref.make<BackendAnswer>("busy") };
      yield* runListener({
        backends: [primary, wsl],
        scenario: ({ downloads, installs }) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.seconds(1));
            assert.equal(yield* Ref.get(downloads), 1);

            yield* TestClock.adjust(Duration.minutes(30));
            assert.equal(yield* Ref.get(installs), 0, "an agent is running in WSL");

            yield* Ref.set(wsl.answer, "idle");
            yield* TestClock.adjust(Duration.minutes(4));
            assert.equal(yield* Ref.get(installs), 0);
            yield* TestClock.adjust(Duration.minutes(3));
            assert.equal(yield* Ref.get(installs), 1);
          }),
      });
    }),
  );

  it.effect("counts unreachable and restarting backends as busy", () =>
    Effect.gen(function* () {
      const unreachable = {
        id: "local",
        port: 3773,
        answer: yield* Ref.make<BackendAnswer>("unreachable"),
      };
      const restarting = {
        id: "wsl:ubuntu",
        port: 4773,
        answer: yield* Ref.make<BackendAnswer>("idle"),
        ready: false,
      };
      yield* runListener({
        backends: [unreachable, restarting],
        scenario: ({ installs }) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.minutes(30));
            assert.equal(yield* Ref.get(installs), 0);
          }),
      });
    }),
  );

  it.effect("checks the backends again right before restarting", () =>
    Effect.gen(function* () {
      const primary = { id: "local", port: 3773, answer: yield* Ref.make<BackendAnswer>("idle") };
      yield* runListener({
        backends: [primary],
        settings: { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, autoInstallUpdates: false },
        scenario: ({ installs, state }) =>
          Effect.gen(function* () {
            const settings = yield* DesktopAppSettings.DesktopAppSettings;
            yield* SubscriptionRef.set(state, downloadedState);
            // Mid-interval, so the next poll is 30 seconds away.
            yield* TestClock.adjust(Duration.seconds(630));
            yield* settings.setAutoInstallUpdates(true).pipe(Effect.orDie);
            // A turn starts after the last poll; an updater state change then
            // reaches the install decision before the next poll would see it.
            yield* Ref.set(primary.answer, "busy");
            yield* SubscriptionRef.set(state, { ...downloadedState, checkedAt: "later" });
            yield* TestClock.adjust(Duration.seconds(1));
            assert.equal(yield* Ref.get(installs), 0);
          }),
      });
    }),
  );

  it.effect("does not retry a version whose install failed", () =>
    Effect.gen(function* () {
      const primary = { id: "local", port: 3773, answer: yield* Ref.make<BackendAnswer>("idle") };
      yield* runListener({
        backends: [primary],
        installFails: true,
        scenario: ({ installs, state }) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.minutes(6));
            assert.equal(yield* Ref.get(installs), 1);
            // The updater's next check clears the error but keeps the download.
            yield* SubscriptionRef.set(state, downloadedState);
            yield* TestClock.adjust(Duration.minutes(30));
            assert.equal(yield* Ref.get(installs), 1);
          }),
      });
    }),
  );

  it.effect("stays put when automatic updates are turned off", () =>
    Effect.gen(function* () {
      const primary = { id: "local", port: 3773, answer: yield* Ref.make<BackendAnswer>("idle") };
      yield* runListener({
        backends: [primary],
        settings: { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, autoInstallUpdates: false },
        scenario: ({ downloads, installs }) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.minutes(30));
            assert.equal(yield* Ref.get(downloads), 0);
            assert.equal(yield* Ref.get(installs), 0);
          }),
      });
    }),
  );
});
