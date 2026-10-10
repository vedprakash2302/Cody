import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { beforeEach } from "vite-plus/test";

import { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2Workspace,
  makeOpenCode2ModelLoader,
  type OpenCode2Model,
  type OpenCode2Workspace,
  openCode2CommandsToServerProviderSlashCommands,
  openCode2SkillsToServerProviderSkills,
  openCodeCommandsToServerProviderSlashCommands,
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
      // SHA-256 of "opencode-go\0instance-key".
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

/**
 * The legacy `OpenCodeProviderLive` Layer + `OpenCodeProvider` service tag
 * are deleted. The snapshot-producing logic they wrapped now lives in the
 * standalone `checkOpenCodeProviderStatus(settings, cwd)` Effect, which
 * drivers call directly when building their per-instance snapshot
 * `ManagedServerProvider`. Tests mirror that shape: build a settings payload,
 * invoke the check, assert on the returned snapshot.
 */

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    runVersionPending: false,
    versionStdout: DEFAULT_VERSION_STDOUT,
    inventoryError: null as Error | null,
    connectionError: null as Error | null,
    inventoryCwd: null as string | null,
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

it("keeps native and MCP commands while preserving compaction and separate skills", () => {
  NodeAssert.deepEqual(
    openCodeCommandsToServerProviderSlashCommands([
      { name: "review", description: "Review changes", source: "command", hints: ["$ARGUMENTS"] },
      { name: "review", source: "command", hints: [] },
      { name: "compact", source: "command", hints: [] },
      { name: "skill", source: "skill", hints: [] },
      { name: "mcp:search", source: "mcp", hints: ["query"] },
    ]).slice(1),
    [
      { name: "review", description: "Review changes", input: { hint: "$ARGUMENTS" } },
      { name: "mcp:search", input: { hint: "query" } },
    ],
  );
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
  it.effect("shows a codex-style missing binary message", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode CLI (`opencode`) is not installed or not on PATH.",
      );
    }),
  );

  it.effect("hides generic Effect.tryPromise text for local CLI probe failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("An error occurred in Effect.tryPromise");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.message, "Failed to execute OpenCode CLI health check.");
    }),
  );

  it.effect("times out a hanging local CLI version probe", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionPending = true;
      const probeFiber = yield* checkProvider(makeOpenCodeSettings()).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("4 seconds");
      const snapshot = yield* Fiber.join(probeFiber);

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "Failed to execute OpenCode CLI health check: OpenCode CLI version probe timed out after 4 seconds.",
      );
    }).pipe(Effect.provide(TestClock.layer())),
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

  it.effect("loads local inventory from a scoped OpenCode server", () =>
    Effect.gen(function* () {
      yield* checkProvider(makeOpenCodeSettings({ serverPassword: "secret-password" }));

      NodeAssert.deepEqual(runtimeMock.state.sdkClientInputs, [
        {
          baseUrl: "http://127.0.0.1:4301",
          directory: process.cwd(),
          serverPassword: "secret-password",
        },
      ]);
      NodeAssert.equal(runtimeMock.state.closeCalls, 1);
      NodeAssert.equal(runtimeMock.state.inventoryCwd, null);
    }),
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
      NodeAssert.deepEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      // Plan mode runs as OpenCode's plan agent, and every session can compact.
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
      // A failed catalog read still leaves the session able to compact.
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        ["compact"],
      );
    }),
  );

  it.effect("uses an environment-only password for local inventory", () =>
    Effect.gen(function* () {
      yield* checkProvider(makeOpenCodeSettings(), process.cwd(), {
        OPENCODE_SERVER_PASSWORD: "environment-password",
      });

      NodeAssert.deepEqual(runtimeMock.state.sdkClientInputs, [
        {
          baseUrl: "http://127.0.0.1:4301",
          directory: process.cwd(),
          serverPassword: "environment-password",
        },
      ]);
    }),
  );

  it.effect("uses the settings password when local environment auth differs", () =>
    Effect.gen(function* () {
      yield* checkProvider(
        makeOpenCodeSettings({ serverPassword: "settings-password" }),
        process.cwd(),
        { OPENCODE_SERVER_PASSWORD: "environment-password" },
      );

      NodeAssert.equal(runtimeMock.state.sdkClientInputs[0]?.serverPassword, "settings-password");
    }),
  );

  it.effect("reports local model inventory failures without treating them as empty", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("opencode models failed");
      const snapshot = yield* checkProvider(makeOpenCodeSettings());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.equal(
        snapshot.message,
        "Failed to load OpenCode provider inventory: opencode models failed",
      );
    }),
  );
});

it.layer(layerTest)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect("does not send a local environment password to a configured server", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
        process.cwd(),
        { OPENCODE_SERVER_PASSWORD: "local-secret" },
      );

      NodeAssert.equal(snapshot.version, "1.14.19");
      NodeAssert.deepEqual(runtimeMock.state.sdkClientInputs, [
        {
          baseUrl: "http://127.0.0.1:9999",
          directory: process.cwd(),
        },
      ]);
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

  it.effect("surfaces a friendly auth error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.connectionError = new Error("401 Unauthorized");
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("surfaces a friendly connection error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.connectionError = new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:9999",
      );
      const snapshot = yield* checkProvider(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
      );

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct.",
      );
    }),
  );
});

const bigPickle: OpenCode2Model = {
  providerID: "opencode",
  id: "big-pickle",
  name: "Big Pickle",
  variants: [],
};

it.effect("waits for a fresh OpenCode 2 server to list its models", () =>
  Effect.gen(function* () {
    // A fresh server lists nothing until its catalog loads.
    const replies: Array<ReadonlyArray<OpenCode2Model>> = [[], [], [bigPickle]];
    const load = yield* makeOpenCode2ModelLoader(Effect.sync(() => replies.shift() ?? [bigPickle]));
    const fiber = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    NodeAssert.deepEqual(yield* Fiber.join(fiber), [bigPickle]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps the last OpenCode 2 model list while a fresh server's stays empty", () =>
  Effect.gen(function* () {
    let listed: ReadonlyArray<OpenCode2Model> = [bigPickle];
    const load = yield* makeOpenCode2ModelLoader(Effect.sync(() => listed));
    NodeAssert.deepEqual(yield* load, [bigPickle]);
    listed = [];
    const fiber = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("6 seconds");
    NodeAssert.deepEqual(yield* Fiber.join(fiber), [bigPickle]);
  }).pipe(Effect.provide(TestClock.layer())),
);

// What 2.0.18 lists for a directory once it has scanned it (live, 2026-09-29).
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
    // A directory the server has not served yet lists no commands until its scan ends.
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

it.effect("takes a served OpenCode 2 directory's first listing as is", () =>
  Effect.gen(function* () {
    const workspace = yield* loadOpenCode2Workspace(Effect.succeed(scanned), Effect.never);
    NodeAssert.deepEqual(workspace, scanned);
  }),
);

it("lists an OpenCode 2 directory's skills by id and its commands after /compact", () => {
  NodeAssert.deepEqual(
    openCode2SkillsToServerProviderSkills(scanned.skills).map((skill) => [
      skill.name,
      skill.displayName,
      skill.path,
    ]),
    [
      ["greet", undefined, "/work/.opencode/skills/greet/SKILL.md"],
      ["opencode", "OpenCode", "/builtin/opencode.md"],
      ["report", "Report", "/builtin/report.md"],
    ],
  );
  NodeAssert.deepEqual(
    openCode2CommandsToServerProviderSlashCommands([
      ...scanned.commands,
      { name: "compact", description: "a workspace command named like T3's own" },
    ]).map((command) => command.name),
    ["compact", "init", "review", "hello"],
  );
});
