import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { beforeEach } from "vite-plus/test";

import { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2Workspace,
  type OpenCode2Model,
  type OpenCode2Workspace,
} from "./status.ts";
import { readOpenCodeUsageLimits } from "./usageLimits.ts";
import { probeOpenCodeRuntime } from "./versionProbe.ts";
import {
  OPENCODE_1_RESPONSES,
  OPENCODE_2_RESPONSES,
  replayOpenCodeServer,
} from "./probeResponses.fixture.ts";
const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";

it.effect("reads Go limits with the instance's XDG credentials and preserves reset times", () =>
  Effect.gen(function* () {
    const resetsAt = "2026-09-17T12:00:00.000Z";
    const limits = yield* readOpenCodeUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { XDG_DATA_HOME: "/instance/data", OPENCODE_API_KEY: "env-key" },
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            NodeAssert.equal(path, "/instance/data/opencode/auth.json");
            return Effect.succeed(
              JSON.stringify({ "opencode-go": { type: "api", key: "instance-key" } }),
            );
          },
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          NodeAssert.equal(request.url, "https://opencode.ai/zen/go/v1/usage");
          NodeAssert.equal(request.headers.authorization, "Bearer instance-key");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                usage: {
                  rolling: { percent: 0, resetsAt },
                  weekly: { percent: 10, resetsAt },
                  monthly: { percent: 125, resetsAt },
                },
              }),
            ),
          );
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(limits.unavailable, undefined);
    NodeAssert.equal(
      limits.credentialFingerprint,
      "aba48e85c981a8edc1c9fb4575121accc7235fa55d0f8689f66f153de5566a37",
    );
    NodeAssert.deepEqual(
      limits.windows.map(({ kind, usedPercent, resetsAt: reset }) => ({
        kind,
        usedPercent,
        reset,
      })),
      [
        { kind: "session", usedPercent: 0, reset: resetsAt },
        { kind: "weekly", usedPercent: 10, reset: resetsAt },
        { kind: "monthly", usedPercent: 100, reset: resetsAt },
      ],
    );
  }),
);

it.effect(
  "uses the selected public Console key for Go limits, falling back only on auth rejection",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataHome = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${dataHome}/opencode`);
      yield* fs.writeFileString(
        `${dataHome}/opencode/auth.json`,
        JSON.stringify({ "opencode-go": { type: "api", key: "go-key" } }),
      );
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(`${dataHome}/opencode/opencode.db`)),
        (database) => Effect.sync(() => database.close()),
      );
      database.exec(
        "CREATE TABLE credential (id text PRIMARY KEY, integration_id text, value text, active integer, time_created integer, time_updated integer)",
      );
      const insert = database.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?)");
      const window = { percent: 1, resetsAt: "2026-09-17T12:00:00.000Z" };
      const consoleKey = { type: "key", key: "console-key" };
      const fingerprints = new Map([
        ["console-key", "3e45cfde9158185930d4cc7020a4e390895574fd54bd8f9631d23a336bbf94f0"],
        ["go-key", "d0e590e93fc9bd9353f2b993c0c287391cae505da2a78cb698b75418d2f5367e"],
        ["inline-key", "85649de18e63305548b6407e185f708483727ee6189cc4bc9512ddb17e23e776"],
      ]);
      for (const {
        consoleRow = consoleKey,
        active = 1,
        consoleStatus = 200,
        inline = false,
        databaseFile,
        requested,
      } of [
        {
          consoleRow: { ...consoleKey, metadata: { server: "https://opencode.ai/console" } },
          requested: ["console-key"],
        },
        { consoleStatus: 401, requested: ["console-key", "go-key"] },
        { consoleStatus: 403, requested: ["console-key", "go-key"] },
        { consoleStatus: 500, requested: ["console-key"] },
        { active: 0, requested: ["go-key"] },
        {
          consoleRow: {
            type: "oauth",
            methodID: "device",
            access: "token",
            refresh: "refresh",
            expires: 0,
          },
          requested: ["go-key"],
        },
        {
          consoleRow: { ...consoleKey, metadata: { server: "https://console.example" } },
          requested: ["go-key"],
        },
        { inline: true, requested: ["inline-key"] },
        { databaseFile: "selected.db", requested: ["console-key"] },
        { databaseFile: ":memory:", requested: ["go-key"] },
        { active: null, requested: ["console-key"] },
      ]) {
        database.exec("DELETE FROM credential");
        insert.run("cred_selected", "opencode", JSON.stringify(consoleRow), active, 2, 2);
        // Legacy selections follow creation order, even when an older key was updated later.
        insert.run(
          "cred_older",
          "opencode",
          JSON.stringify({ type: "key", key: "old-key" }),
          active === null ? null : 0,
          1,
          9,
        );
        insert.run("cred_other", "other", JSON.stringify(consoleKey), 1, 10, 10);
        if (databaseFile === "selected.db") {
          yield* fs.writeFile(
            `${dataHome}/opencode/selected.db`,
            yield* fs.readFile(`${dataHome}/opencode/opencode.db`),
          );
          database
            .prepare("UPDATE credential SET value = ? WHERE id = 'cred_selected'")
            .run(JSON.stringify({ type: "key", key: "old-key" }));
        }
        const before = yield* fs.readFile(`${dataHome}/opencode/opencode.db`);
        const authorizations: string[] = [];
        const limits = yield* readOpenCodeUsageLimits({
          enabled: true,
          serverUrl: "",
          environment: {
            XDG_DATA_HOME: dataHome,
            ...(databaseFile !== undefined ? { OPENCODE_DB: databaseFile } : {}),
            ...(inline
              ? { OPENCODE_AUTH_CONTENT: '{"opencode-go":{"type":"api","key":"inline-key"}}' }
              : {}),
          },
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              NodeAssert.equal(request.url, "https://opencode.ai/zen/go/v1/usage");
              const key = (request.headers.authorization ?? "").replace("Bearer ", "");
              authorizations.push(key);
              // The legacy key is expired in the regression; it only works in fallback scenarios.
              const status =
                key === "console-key" ? consoleStatus : requested.includes(key) ? 200 : 401;
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    { usage: { rolling: window, weekly: window, monthly: window } },
                    { status },
                  ),
                ),
              );
            }),
          ),
        );
        NodeAssert.deepEqual(authorizations, requested);
        NodeAssert.deepEqual(yield* fs.readFile(`${dataHome}/opencode/opencode.db`), before);
        NodeAssert.equal(
          limits.unavailable?.reason,
          consoleStatus === 500 ? "probeFailed" : undefined,
        );
        NodeAssert.equal(limits.windows.length, consoleStatus === 500 ? 0 : 3);
        NodeAssert.equal(
          limits.credentialFingerprint,
          consoleStatus === 500 ? undefined : fingerprints.get(requested.at(-1)!),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not read local credentials for external or disabled OpenCode instances", () =>
  Effect.gen(function* () {
    for (const settings of [
      { enabled: true, serverUrl: "https://remote.example" },
      { enabled: false, serverUrl: "" },
    ]) {
      const limits = yield* readOpenCodeUsageLimits({ ...settings, environment: {} }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("unexpected credential read"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected usage request")),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, "unsupported");
    }
  }),
);

it.effect("keeps Go entitlement absence distinct from failed or malformed usage responses", () =>
  Effect.gen(function* () {
    for (const [status, reason] of [
      [403, "unsupported"],
      [401, "probeFailed"],
      [200, "probeFailed"],
    ] as const) {
      const limits = yield* readOpenCodeUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          OPENCODE_AUTH_CONTENT: '{"opencode-go":{"type":"api","key":"inline-key"}}',
        },
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("inline credentials must bypass disk"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status }))),
          ),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, reason);
      NodeAssert.equal(limits.credentialFingerprint, undefined);
      NodeAssert.deepEqual(limits.windows, []);
    }
  }),
);

const copilotUser = (snapshots: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  Response.json({
    quota_reset_date_utc: "2026-10-01T00:00:00.000Z",
    quota_snapshots: snapshots,
    ...extra,
  });

const readCopilotLimits = (response: () => Response, auth?: string) =>
  readOpenCodeUsageLimits({
    enabled: true,
    serverUrl: "",
    environment: {
      OPENCODE_AUTH_CONTENT:
        auth ??
        '{"github-copilot":{"type":"oauth","refresh":"gho_token","access":"x","expires":0}}',
    },
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response()))),
    ),
    Effect.provide(NodeServices.layer),
  );

it.effect("reads Copilot quotas from the OpenCode login and drops unlimited ones", () =>
  Effect.gen(function* () {
    for (const [auth, expectedUrl] of [
      [
        '{"github-copilot":{"type":"oauth","refresh":"gho_token","access":"x","expires":0}}',
        "https://api.github.com/copilot_internal/user",
      ],
      [
        '{"github-copilot":{"type":"oauth","refresh":"gho_token","enterpriseUrl":"octocorp.ghe.com"}}',
        "https://api.octocorp.ghe.com/copilot_internal/user",
      ],
    ] as const) {
      const limits = yield* readOpenCodeUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: { OPENCODE_AUTH_CONTENT: auth },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            NodeAssert.equal(request.url, expectedUrl);
            NodeAssert.equal(request.headers.authorization, "Bearer gho_token");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                copilotUser(
                  {
                    premium_interactions: {
                      percent_remaining: 84.6,
                      unlimited: false,
                      entitlement: 2_000_000,
                      token_based_billing: true,
                    },
                    chat: { percent_remaining: 100, unlimited: true, entitlement: 0 },
                    completions: { percent_remaining: 100, unlimited: true, entitlement: 0 },
                  },
                  { token_based_billing: true },
                ),
              ),
            );
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable, undefined);
      NodeAssert.deepEqual(limits.windows, [
        {
          id: "copilot_premium_interactions",
          kind: "monthly",
          label: "Copilot · AI credits",
          usedPercent: 100 - 84.6,
          resetsAt: "2026-10-01T00:00:00.000Z",
        },
      ]);
    }
  }),
);

it.effect("skips Copilot snapshots it cannot use instead of failing the probe", () =>
  Effect.gen(function* () {
    const limits = yield* readCopilotLimits(() =>
      copilotUser({
        // Premium requests plans keep their name.
        premium_interactions: { percent_remaining: 40, unlimited: false, entitlement: 300 },
        // Metered but with no allotment: no meaningful percentage.
        chat: { percent_remaining: 100, unlimited: false, entitlement: 0 },
        completions: { percent_remaining: "unknown" },
      }),
    );
    NodeAssert.deepEqual(
      limits.windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
      [{ label: "Copilot · Premium requests", usedPercent: 60 }],
    );

    const nothingUsable = yield* readCopilotLimits(() =>
      copilotUser({ premium_interactions: null, chat: { unlimited: false } }),
    );
    NodeAssert.equal(nothingUsable.unavailable?.reason, "unsupported");
  }),
);

it.effect("shows the accounts that answered when another OpenCode login fails", () =>
  Effect.gen(function* () {
    const auth =
      '{"opencode-go":{"type":"api","key":"go-key"},"github-copilot":{"type":"oauth","refresh":"gho_token"}}';
    const probe = (failing: "none" | "go" | "copilot" | "both" | "copilotUnlimited") =>
      readOpenCodeUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: { OPENCODE_AUTH_CONTENT: auth },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const isGo = request.url.includes("opencode.ai");
            const fail = failing === "both" || failing === (isGo ? "go" : "copilot");
            if (fail) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({}, { status: 500 })),
              );
            }
            const resetsAt = "2026-09-17T12:00:00.000Z";
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                isGo
                  ? Response.json({
                      usage: {
                        rolling: { percent: 5, resetsAt },
                        weekly: { percent: 5, resetsAt },
                        monthly: { percent: 5, resetsAt },
                      },
                    })
                  : copilotUser({
                      premium_interactions: {
                        percent_remaining: 50,
                        unlimited: failing === "copilotUnlimited",
                        entitlement: 300,
                      },
                    }),
              ),
            );
          }),
        ),
        Effect.provide(NodeServices.layer),
      );

    const goFailed = yield* probe("go");
    NodeAssert.deepEqual(
      goFailed.windows.map((window) => window.id),
      ["copilot_premium_interactions"],
    );
    const copilotFailed = yield* probe("copilot");
    NodeAssert.deepEqual(
      copilotFailed.windows.map((window) => window.id),
      ["go_rolling", "go_weekly", "go_monthly"],
    );
    const bothFailed = yield* probe("both");
    NodeAssert.deepEqual(bothFailed.unavailable, {
      reason: "probeFailed",
      message: "OpenCode Go and GitHub Copilot could not read usage.",
    });
    const copilotUnlimited = yield* probe("copilotUnlimited");
    NodeAssert.equal(copilotUnlimited.windows.length, 3);

    // Pooled views match accounts by the credentials behind the shown windows.
    // Go alone must hash as upstream does so it pools with upstream environments.
    // SHA-256 of "opencode-go\0go-key".
    const goOnlyFingerprint = "d0e590e93fc9bd9353f2b993c0c287391cae505da2a78cb698b75418d2f5367e";
    NodeAssert.equal(copilotFailed.credentialFingerprint, goOnlyFingerprint);
    NodeAssert.equal(copilotUnlimited.credentialFingerprint, goOnlyFingerprint);
    const bothAnswered = yield* probe("none");
    NodeAssert.ok(goFailed.credentialFingerprint);
    NodeAssert.ok(bothAnswered.credentialFingerprint);
    const fingerprints = new Set([
      goOnlyFingerprint,
      goFailed.credentialFingerprint,
      bothAnswered.credentialFingerprint,
    ]);
    NodeAssert.equal(fingerprints.size, 3);
    NodeAssert.equal(bothFailed.credentialFingerprint, undefined);
  }),
);

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    runVersionPending: false,
    versionStdout: DEFAULT_VERSION_STDOUT,
    inventoryError: null as Error | null,
    connectionError: null as Error | null,
    inventoryCwd: null as string | null,
    startCalls: 0,
    closeCalls: 0,
    sdkClientInputs: [] as Array<{
      baseUrl: string;
      directory: string;
      serverPassword?: string;
    }>,
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      skills: [] as unknown[],
    } as unknown,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.runVersionPending = false;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.inventoryError = null;
    this.state.connectionError = null;
    this.state.inventoryCwd = null;
    this.state.startCalls = 0;
    this.state.closeCalls = 0;
    this.state.sdkClientInputs.length = 0;
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
      skills: [] as unknown[],
    };
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
  startOpenCodeServerProcess: ({ serverPassword, environment }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls += 1;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls += 1;
        }),
      );
      const effectiveServerPassword = OpenCodeRuntime.resolveOpenCodeServerPassword({
        external: false,
        ...(serverPassword !== undefined ? { serverPassword } : {}),
        ...(environment !== undefined ? { environment } : {}),
      });
      return {
        url: "http://127.0.0.1:4301",
        ...(effectiveServerPassword !== undefined
          ? { serverPassword: effectiveServerPassword }
          : {}),
        version: "1.14.19",
        isRunning: Effect.succeed(true),
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    Effect.gen(function* () {
      if (runtimeMock.state.connectionError) {
        return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "global.health",
          detail: runtimeMock.state.connectionError.message,
          cause: runtimeMock.state.connectionError,
        });
      }
      if (!serverUrl) {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls += 1;
          }),
        );
      }
      return {
        url: serverUrl ?? "http://127.0.0.1:4301",
        ...(serverPassword ? { serverPassword } : {}),
        version: "1.14.19",
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () =>
    runtimeMock.state.runVersionPending
      ? Effect.never
      : runtimeMock.state.runVersionError
        ? Effect.fail(
            new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "runOpenCodeCommand",
              detail: runtimeMock.state.runVersionError.message,
              cause: runtimeMock.state.runVersionError,
            }),
          )
        : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
  createOpenCodeSdkClient: (input) => {
    runtimeMock.state.sdkClientInputs.push(input);
    return {} as unknown as ReturnType<
      OpenCodeRuntime.OpenCodeRuntime["Service"]["createOpenCodeSdkClient"]
    >;
  },
  loadOpenCodeInventory: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "loadOpenCodeInventory",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeRuntime.OpenCodeInventory),
  loadInventoryFromCli: ({ cwd }) => {
    runtimeMock.state.inventoryCwd = cwd;
    return runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "loadInventoryFromCli",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeRuntime.OpenCodeInventory);
  },
  loadOpenCodeSkills: () => Effect.succeed([]),
  loadSkillsFromCli: () => Effect.succeed([]),
};

beforeEach(() => {
  runtimeMock.reset();
});

const layerTest = Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makeOpenCodeSettings = (overrides?: Partial<OpenCodeSettings>): OpenCodeSettings =>
  decodeOpenCodeSettings({
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

const checkProvider = Effect.fn("checkProvider")(function* (
  settings: OpenCodeSettings,
  cwd = process.cwd(),
  environment?: NodeJS.ProcessEnv,
  server = replayOpenCodeServer(OPENCODE_1_RESPONSES, settings.serverPassword),
  openCode2Models: Effect.Effect<
    ReadonlyArray<OpenCode2Model>,
    OpenCodeRuntime.OpenCodeRuntimeError
  > = Effect.succeed([]),
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const serverOwner = yield* OpenCodeServerOwner.make({
        binaryPath: settings.binaryPath,
        directory: cwd,
        ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
        ...(environment ? { environment } : {}),
      });
      const probe = probeOpenCodeRuntime(settings, environment).pipe(
        Effect.provideService(HttpClient.HttpClient, server),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, OpenCodeRuntimeTestDouble),
      );
      return yield* checkOpenCodeProviderStatus(settings, cwd, probe, openCode2Models).pipe(
        Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
      );
    }),
  );
});

it.layer(layerTest)("checkOpenCodeProviderStatus", (it) => {
  it.effect.each(["version", "inventory", "models", "empty-v1", "empty-v2"] as const)(
    "records %s discovery failures in the existing trace and logger",
    (failure) =>
      Effect.gen(function* () {
        const cause = new Error("discovery connection reset");
        const v2 = failure === "models" || failure === "empty-v2";
        runtimeMock.state.versionStdout = v2 ? "opencode v2.0.18\n" : DEFAULT_VERSION_STDOUT;
        if (failure === "version") runtimeMock.state.runVersionError = cause;
        if (failure === "inventory") runtimeMock.state.inventoryError = cause;
        if (failure === "empty-v1") {
          runtimeMock.state.inventory = {
            providerList: {
              connected: ["openai"],
              all: [{ id: "openai", name: "OpenAI", models: {} }],
              default: {},
            },
            agents: [],
            skills: [],
          };
        }
        const spans: Array<Tracer.NativeSpan> = [];
        yield* checkProvider(
          makeOpenCodeSettings({ serverPassword: "private-password" }),
          process.cwd(),
          undefined,
          undefined,
          failure === "models"
            ? Effect.fail(
                new OpenCodeRuntime.OpenCodeRuntimeError({
                  operation: "model.list",
                  detail: "model list failed",
                  cause,
                }),
              )
            : Effect.succeed([]),
        ).pipe(
          Effect.provideService(
            Tracer.Tracer,
            Tracer.make({
              span: (options) => {
                const span = new Tracer.NativeSpan(options);
                spans.push(span);
                return span;
              },
            }),
          ),
          Effect.provide(Logger.layer([Logger.tracerLogger], { mergeWithExisting: false })),
        );

        const diagnostics = spans.flatMap((span) =>
          span.events
            .filter(([name]) => name === "OpenCode discovery failed")
            .map((event) => ({ span, event })),
        );
        NodeAssert.equal(diagnostics.length, 1);
        const {
          span,
          event: [, timestamp, attributes],
        } = diagnostics[0]!;
        NodeAssert.equal(attributes.provider, "opencode");
        NodeAssert.equal(
          attributes.phase,
          failure.startsWith("empty") ? (v2 ? "models" : "inventory") : failure,
        );
        NodeAssert.equal(attributes.outcome, failure.startsWith("empty") ? "empty" : "failed");
        NodeAssert.equal(attributes.serverMode, "managed");
        NodeAssert.equal(attributes["effect.logLevel"], "WARN");
        NodeAssert.ok(timestamp >= 0n);
        NodeAssert.ok(span.traceId.length > 0);
        NodeAssert.equal(span.attributes.get("discovery.outcome"), attributes.outcome);
        if (!failure.startsWith("empty")) {
          NodeAssert.match(String(attributes["effect.cause"]), /discovery connection reset/);
        }
        NodeAssert.ok(!JSON.stringify(attributes).includes("private-password"));
      }),
  );

  it.effect("keeps an empty legacy catalog retryable until connected providers list models", () =>
    Effect.gen(function* () {
      const upstream = { id: "openai", name: "OpenAI", models: {} };
      runtimeMock.state.inventory = {
        providerList: { connected: ["openai"], all: [upstream], default: {} },
        agents: [],
        skills: [],
      };
      const settings = makeOpenCodeSettings();
      const empty = yield* checkProvider(settings);
      NodeAssert.equal(empty.status, "warning");
      NodeAssert.equal(empty.auth.status, "unknown");
      NodeAssert.deepEqual(empty.models, []);

      upstream.models = {
        "gpt-5.4": { id: "gpt-5.4", name: "GPT-5.4", variants: {} },
      };
      const ready = yield* checkProvider(settings);
      NodeAssert.equal(ready.status, "ready");
      NodeAssert.equal(ready.auth.status, "authenticated");
      NodeAssert.deepEqual(
        ready.models.map((model) => model.slug),
        ["openai/gpt-5.4"],
      );
    }),
  );

  it.effect("emits OpenCode variant defaults so trait picker can resolve a visible selection", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  variants: {
                    none: {},
                    low: {},
                    medium: {},
                    high: {},
                    xhigh: {},
                  },
                },
              },
            },
          ],
          default: {},
        },
        agents: [
          { name: "build", hidden: false, mode: "primary" },
          { name: "plan", hidden: false, mode: "primary" },
        ],
      };

      const snapshot = yield* checkProvider(makeOpenCodeSettings());
      const model = snapshot.models.find((entry) => entry.slug === "openai/gpt-5.4");

      NodeAssert.ok(model);
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      NodeAssert.ok(variantDescriptor && variantDescriptor.type === "select");
      NodeAssert.equal(
        variantDescriptor.options.find((option) => option.isDefault === true)?.id,
        "medium",
      );
      const agentDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "agent" && descriptor.type === "select",
      );
      NodeAssert.ok(agentDescriptor && agentDescriptor.type === "select");
      NodeAssert.equal(
        agentDescriptor.options.find((option) => option.isDefault === true)?.id,
        "build",
      );
    }),
  );

  it.effect("includes OpenCode skills in the provider snapshot", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  variants: {},
                },
              },
            },
          ],
          default: {},
        },
        agents: [],
        skills: [
          {
            name: "openclaw-review",
            description: "Review OpenClaw workflow changes.",
            location: "/Users/test/.agents/skills/openclaw-review/SKILL.md",
          },
          {
            name: "openclaw-triage",
            description: "Triage OpenClaw routing issues.",
            location: "/Users/test/.agents/skills/openclaw-triage/SKILL.md",
          },
          {
            name: "missing-location",
            description: "This incomplete SDK row should be skipped.",
            location: "",
          },
        ],
      };

      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.deepEqual(
        snapshot.skills.map((skill) => ({
          name: skill.name,
          path: skill.path,
          enabled: skill.enabled,
          shortDescription: skill.shortDescription,
        })),
        [
          {
            name: "openclaw-review",
            path: "/Users/test/.agents/skills/openclaw-review/SKILL.md",
            enabled: true,
            shortDescription: "Review OpenClaw workflow changes.",
          },
          {
            name: "openclaw-triage",
            path: "/Users/test/.agents/skills/openclaw-triage/SKILL.md",
            enabled: true,
            shortDescription: "Triage OpenClaw routing issues.",
          },
        ],
      );
    }),
  );

  it.effect("reports the upgraded CLI without restarting a borrowed OpenCode server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = makeOpenCodeSettings();
        const owner = yield* OpenCodeServerOwner.make({
          binaryPath: settings.binaryPath,
          directory: process.cwd(),
        });
        yield* owner.withServer(() =>
          Effect.gen(function* () {
            runtimeMock.state.versionStdout = "opencode 1.14.20\n";
            const snapshot = yield* checkOpenCodeProviderStatus(
              settings,
              process.cwd(),
              probeOpenCodeRuntime(settings).pipe(
                Effect.provideService(
                  HttpClient.HttpClient,
                  replayOpenCodeServer(OPENCODE_1_RESPONSES, settings.serverPassword),
                ),
                Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, OpenCodeRuntimeTestDouble),
              ),
              Effect.succeed([]),
            ).pipe(Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, owner));

            NodeAssert.equal(snapshot.version, "1.14.19");
            NodeAssert.equal(snapshot.installedVersion, "1.14.20");
            NodeAssert.equal(runtimeMock.state.startCalls, 1);
            NodeAssert.equal(runtimeMock.state.closeCalls, 0);
          }),
        );
      }),
    ),
  );

  it.effect("lists a local OpenCode 2 binary's models in Full access only, never via 1.x", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "opencode v2.0.18\n";
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        undefined,
        Effect.succeed([
          { providerID: "opencode", id: "big-pickle", name: "Big Pickle", variants: [] },
          {
            providerID: "opencode",
            id: "space-bunny-free",
            name: "Space Bunny Free",
            variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
          },
        ]),
      );

      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(snapshot.version, "2.0.18");
      NodeAssert.equal("installedVersion" in snapshot, false);
      NodeAssert.deepEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      NodeAssert.equal(snapshot.showInteractionModeToggle, true);
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        ["compact"],
      );
      NodeAssert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["opencode/big-pickle", "opencode/space-bunny-free"],
      );
      const variant = snapshot.models.find((model) => model.slug === "opencode/space-bunny-free")
        ?.capabilities?.optionDescriptors?.[0];
      NodeAssert.deepEqual(
        variant?.type === "select" ? variant.options.map((option) => option.id) : [],
        ["low", "medium", "high"],
      );
      NodeAssert.equal(runtimeMock.state.sdkClientInputs.length, 0);
    }),
  );

  it.effect("marks older releases of a family and deprecated models as legacy", () =>
    Effect.gen(function* () {
      const releases = [
        ["opencode", "opus-4-5", "claude-opus", "2025-11-24", "active"],
        ["opencode", "opus-5-5", "claude-opus", "2026-09-22", "active"],
        ["opencode", "opus-preview", "claude-opus", "2026-10-01", "deprecated"],
        ["opencode", "flash", "flash", "2026-09-10", "active"],
        ["opencode", "flash-free", "flash", "2026-09-10", "active"],
        ["opencode", "big-pickle", undefined, "2025-10-17", "active"],
        ["openrouter", "opus-4-5", "claude-opus", "2025-11-24", "active"],
      ] as const;
      const legacySlugs = (
        models: ReadonlyArray<{ readonly slug: string; readonly isLegacy?: boolean | undefined }>,
      ) =>
        models
          .filter((model) => model.isLegacy)
          .map((model) => model.slug)
          .toSorted();
      const expected = ["opencode/opus-4-5", "opencode/opus-preview"];

      runtimeMock.state.inventory = {
        providerList: {
          connected: ["opencode", "openrouter"],
          all: ["opencode", "openrouter"].map((providerID) => ({
            id: providerID,
            name: providerID,
            models: Object.fromEntries(
              releases
                .filter(([provider]) => provider === providerID)
                .map(([, id, family, releaseDate, status]) => [
                  id,
                  { id, name: id, family, release_date: releaseDate, status, variants: {} },
                ]),
            ),
          })),
          default: {},
        },
        agents: [],
      };
      NodeAssert.deepEqual(
        legacySlugs((yield* checkProvider(makeOpenCodeSettings())).models),
        expected,
      );

      runtimeMock.state.versionStdout = "opencode v2.0.18\n";
      const openCode2 = yield* checkProvider(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        undefined,
        Effect.succeed(
          releases.map(([providerID, id, family, releaseDate, status]) => ({
            providerID,
            id,
            name: id,
            variants: [],
            family,
            released: Date.parse(releaseDate),
            deprecated: status === "deprecated",
          })),
        ),
      );
      NodeAssert.deepEqual(legacySlugs(openCode2.models), expected);
    }),
  );

  it.effect("reports a failed OpenCode 2 model list without the server's response", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "opencode v2.0.18\n";
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings(),
        process.cwd(),
        undefined,
        undefined,
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "model.list",
            detail: 'status=500 body={"token":"leaked-response-body"}',
          }),
        ),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.message, "OpenCode could not load its model list.");
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        ["compact"],
      );
    }),
  );

  it.effect("reports local model inventory failures without treating them as empty", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "opencode 1.14.20\n";
      runtimeMock.state.inventoryError = new Error("opencode models failed");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.version, "1.14.19");
      NodeAssert.equal(snapshot.installedVersion, "1.14.20");
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.equal(
        snapshot.message,
        "Failed to load OpenCode provider inventory: opencode models failed",
      );
    }),
  );
});

it.layer(layerTest)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect.each([
    "401 Unauthorized",
    "403 Forbidden",
    "status=401 body={}",
    "status=403 body={}",
    "HTTP 401",
    "HTTP/1.1 403",
    "Response status code: 401",
    "Response status code: 403",
    "Request failed with status code 401",
    "Request failed with status code 403",
  ])("keeps explicit authentication rejection actionable: %s", (detail) =>
    Effect.gen(function* () {
      runtimeMock.state.connectionError = new Error(detail);
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.auth.status, "unauthenticated");
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect.each([401, 403, 4010, 4030])("keeps connection failures on port %s retryable", (port) =>
    Effect.gen(function* () {
      const serverUrl = `http://127.0.0.1:${port}`;
      runtimeMock.state.connectionError = new Error(`connect ECONNREFUSED 127.0.0.1:${port}`);
      const snapshot = yield* checkProvider(makeOpenCodeSettings({ serverUrl }));

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.auth.status, "unknown");
      NodeAssert.equal(
        snapshot.message,
        `Couldn't reach the configured OpenCode server at ${serverUrl}. Check that the server is running and the URL is correct.`,
      );
    }),
  );

  it.effect("routes a configured OpenCode 2 server to the 2.x check, never via 1.x", () =>
    Effect.gen(function* () {
      const settings = makeOpenCodeSettings({
        serverUrl: "http://127.0.0.1:9999",
        serverPassword: "secret-password",
      });
      const snapshot = yield* checkProvider(
        settings,
        process.cwd(),
        undefined,
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret-password"),
      );

      NodeAssert.equal(snapshot.status, "warning");
      NodeAssert.equal(snapshot.version, "2.0.18");
      NodeAssert.equal("installedVersion" in snapshot, false);
      NodeAssert.deepEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      NodeAssert.equal(runtimeMock.state.sdkClientInputs.length, 0);
    }),
  );

  it.effect("reports a rejected OpenCode 2 password as an auth error, not a version", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999", serverPassword: "wrong" }),
        process.cwd(),
        undefined,
        replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret-password"),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("rejects an unsupported server before loading inventory", () =>
    Effect.gen(function* () {
      runtimeMock.state.connectionError = new Error(
        "OpenCode v1.14.18 is too old. Upgrade to v1.14.19 or newer.",
      );
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.match(snapshot.message ?? "", /v1\.14\.18 is too old/);
      NodeAssert.equal(runtimeMock.state.sdkClientInputs.length, 0);
    }),
  );
});

const builtinCommands = [
  { name: "init", description: "guided AGENTS.md setup" },
  { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
];
const builtinSkills = [
  { id: "opencode", name: "OpenCode", path: "/builtin/opencode.md" },
  { id: "report", name: "Report", path: "/builtin/report.md" },
];
const scanned: OpenCode2Workspace = {
  commands: [...builtinCommands, { name: "hello", description: "Say hello to the workspace" }],
  skills: [
    ...builtinSkills,
    {
      id: "greet",
      name: "greet",
      path: "/work/.opencode/skills/greet/SKILL.md",
      description: "Greets the user with the secret word MANGO.",
    },
  ],
};

it.effect("reads a fresh OpenCode 2 directory again once its scan has ended", () =>
  Effect.gen(function* () {
    const reads: Array<OpenCode2Workspace> = [{ commands: [], skills: [] }, scanned];
    const scanEnded = yield* Deferred.make<void>();
    const load = yield* loadOpenCode2Workspace(
      Effect.sync(() => reads.shift()!),
      Deferred.await(scanEnded),
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    NodeAssert.equal(reads.length, 1);
    yield* Deferred.succeed(scanEnded, undefined);
    NodeAssert.deepEqual(yield* Fiber.join(load), scanned);
  }),
);
