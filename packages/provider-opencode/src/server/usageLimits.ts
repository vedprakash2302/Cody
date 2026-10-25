import * as NodeSqlite from "node:sqlite";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const AuthFile = Schema.Struct({
  "opencode-go": Schema.optionalKey(Schema.Unknown),
  "github-copilot": Schema.optionalKey(Schema.Unknown),
});
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
// OpenCode's Copilot plugin stores the GitHub OAuth token as `refresh`, and a
// normalized domain in `enterpriseUrl` for GitHub Enterprise (ghe.com) logins.
const CopilotAuth = Schema.Struct({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  enterpriseUrl: Schema.optionalKey(Schema.String),
});
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
const decodeCopilotAuth = Schema.decodeUnknownOption(CopilotAuth);
// OpenCode 2's database tags a stored key "key"; auth.json tags it "api".
const StoredKey = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String,
  metadata: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ server: Schema.optionalKey(Schema.Unknown) })),
  ),
});
const decodeStoredKey = Schema.decodeOption(Schema.fromJsonString(StoredKey));
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

// Select before decoding so an OAuth or self-hosted connection cannot fall
// through to another stored account. NULL-active rows predate the selection flag.
const readConsoleApiKey = (databasePath: string) =>
  Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const row = database
        .prepare(
          `SELECT value FROM credential
           WHERE integration_id = 'opencode' AND active IS NOT 0
           ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`,
        )
        .get();
      const stored =
        typeof row?.value === "string"
          ? Option.getOrUndefined(decodeStoredKey(row.value))
          : undefined;
      const server = stored?.metadata?.server;
      if (typeof server === "string") {
        const url = new URL(server);
        if (`${url.origin}${url.pathname.replace(/\/+$/, "")}` !== "https://opencode.ai/console")
          return undefined;
      }
      return stored?.key.trim();
    } finally {
      database.close();
    }
  }).pipe(Effect.orElseSucceed(() => undefined));

// Every field is optional in GitHub's own client types, so one odd snapshot
// is skipped rather than failing the whole response.
const CopilotQuota = Schema.Struct({
  percent_remaining: Schema.optionalKey(Schema.Finite),
  unlimited: Schema.optionalKey(Schema.Boolean),
  entitlement: Schema.optionalKey(Schema.Finite),
  token_based_billing: Schema.optionalKey(Schema.Boolean),
});
const decodeCopilotQuota = Schema.decodeUnknownOption(CopilotQuota);
const COPILOT_QUOTA_IDS = ["premium_interactions", "chat", "completions"] as const;
const CopilotUserResponse = Schema.Struct({
  quota_reset_date_utc: Schema.optionalKey(Schema.DateTimeUtcFromString),
  token_based_billing: Schema.optionalKey(Schema.Boolean),
  quota_snapshots: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

/**
 * Plans billed in AI credits still report them under `premium_interactions`;
 * only plans that still count premium requests keep that name.
 */
function copilotQuotaLabel(
  quotaId: (typeof COPILOT_QUOTA_IDS)[number],
  tokenBasedBilling: boolean,
): string {
  if (quotaId === "chat") return "Copilot · Chat";
  if (quotaId === "completions") return "Copilot · Completions";
  return tokenBasedBilling ? "Copilot · AI credits" : "Copilot · Premium requests";
}

type GoProbeResult =
  | { readonly windows: ReadonlyArray<ServerProviderUsageWindow>; readonly apiKey: string }
  | "unsupported";

const readGoWindows = Effect.fn("readGoWindows")(function* (keys: {
  readonly consoleKey: string | undefined;
  readonly goKey: string | undefined;
}) {
  let apiKey = keys.consoleKey || keys.goKey;
  if (!apiKey) return "unsupported" as const;
  const client = yield* HttpClient.HttpClient;
  const readUsage = (key: string) =>
    client.execute(
      HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
        HttpClientRequest.bearerToken(key),
      ),
    );
  let response = yield* readUsage(apiKey);
  if ((response.status === 401 || response.status === 403) && keys.goKey && keys.goKey !== apiKey) {
    apiKey = keys.goKey;
    response = yield* readUsage(apiKey);
  }
  // A valid Zen key can exist without a Go subscription.
  if (response.status === 403) return "unsupported" as const;
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
  );
  const windows: ReadonlyArray<ServerProviderUsageWindow> = [
    {
      id: "go_rolling",
      kind: "session",
      label: "Go · Session",
      windowDurationMins: 5 * 60,
      usedPercent: clampPercent(body.usage.rolling.percent),
      resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
    },
    {
      id: "go_weekly",
      kind: "weekly",
      label: "Go · Weekly",
      windowDurationMins: 7 * 24 * 60,
      usedPercent: clampPercent(body.usage.weekly.percent),
      resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
    },
    {
      id: "go_monthly",
      kind: "monthly",
      label: "Go · Monthly",
      usedPercent: clampPercent(body.usage.monthly.percent),
      resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
    },
  ];
  return { windows, apiKey } satisfies GoProbeResult;
});

/**
 * Copilot publishes no quota API; this is the endpoint GitHub's own editor
 * extensions read. Unlimited quotas (chat and completions on paid plans) and
 * quotas with no allotment have nothing to show and are dropped.
 */
const readCopilotWindows = Effect.fn("readCopilotWindows")(function* (
  auth: typeof CopilotAuth.Type,
) {
  const apiHost = auth.enterpriseUrl ? `api.${auth.enterpriseUrl}` : "api.github.com";
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(`https://${apiHost}/copilot_internal/user`).pipe(
      HttpClientRequest.bearerToken(auth.refresh),
      HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
    ),
  );
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(CopilotUserResponse)),
  );
  const resetsAt = body.quota_reset_date_utc
    ? DateTime.formatIso(body.quota_reset_date_utc)
    : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  for (const quotaId of COPILOT_QUOTA_IDS) {
    const decoded = decodeCopilotQuota(body.quota_snapshots?.[quotaId]);
    if (Option.isNone(decoded)) continue;
    const quota = decoded.value;
    if (
      quota.unlimited === true ||
      quota.percent_remaining === undefined ||
      (quota.entitlement !== undefined && quota.entitlement <= 0)
    ) {
      continue;
    }
    windows.push({
      id: `copilot_${quotaId}`,
      kind: "monthly",
      label: copilotQuotaLabel(
        quotaId,
        quota.token_based_billing ?? body.token_based_billing ?? false,
      ),
      usedPercent: clampPercent(100 - quota.percent_remaining),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length > 0 ? windows : ("unsupported" as const);
});

/**
 * Identifies the credentials behind the windows; neither response has an account ID. Unkeyed hashes
 * match across environments; random Go keys and GitHub OAuth tokens resist offline guessing. Go-only
 * limits hash as upstream does, so they pool with environments running upstream T3 Code.
 */
const credentialFingerprint = Effect.fn("credentialFingerprint")(function* (input: {
  readonly goKey: string | undefined;
  readonly copilot: typeof CopilotAuth.Type | undefined;
}) {
  let material = input.goKey ? `opencode-go\0${input.goKey}` : "";
  if (input.copilot) {
    material += `\0github-copilot\0${input.copilot.enterpriseUrl ?? ""}\0${input.copilot.refresh}`;
  }
  const crypto = yield* Crypto.Crypto;
  return yield* crypto
    .digest("SHA-256", new TextEncoder().encode(material))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
});

const guardProbe = <A, E, R>(probe: Effect.Effect<A, E, R>) =>
  probe.pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => "probeFailed" as const),
  );

/**
 * Subscription limits for the accounts OpenCode is signed in to: OpenCode Go
 * and GitHub Copilot. External OpenCode servers own their credentials; never
 * read the host's account for them.
 */
export const readOpenCodeUsageLimits = Effect.fn("readOpenCodeUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const dataHome =
      env.XDG_DATA_HOME ||
      path.join(
        env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    const authPath = path.join(dataHome, "opencode", "auth.json");
    const contents =
      env.OPENCODE_AUTH_CONTENT ||
      (yield* fs.readFileString(authPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
      ));
    const auth = yield* decodeAuthFile(contents);
    const apiAuth = decodeApiAuth(auth["opencode-go"]);
    // OpenCode overlays stored API credentials after environment credentials.
    const goKey = (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    // Console supplies Go credentials in OpenCode 2. Inline auth explicitly
    // overrides local credentials, including the Console connection.
    const databaseFile = env.OPENCODE_DB ?? "opencode.db";
    const consoleKey =
      env.OPENCODE_AUTH_CONTENT || databaseFile === ":memory:"
        ? undefined
        : yield* readConsoleApiKey(path.resolve(dataHome, "opencode", databaseFile));
    const copilotAuth = decodeCopilotAuth(auth["github-copilot"]);

    const probes = yield* Effect.all(
      {
        "OpenCode Go": guardProbe(readGoWindows({ consoleKey, goKey })),
        "GitHub Copilot": Option.isSome(copilotAuth)
          ? guardProbe(readCopilotWindows(copilotAuth.value))
          : Effect.succeed("unsupported" as const),
      },
      { concurrency: "unbounded" },
    );
    const go = probes["OpenCode Go"];
    const copilot = probes["GitHub Copilot"];
    const windows = [
      ...(typeof go === "string" ? [] : go.windows),
      ...(typeof copilot === "string" ? [] : copilot),
    ];
    if (windows.length > 0) {
      return {
        ...makeUsageLimits({ checkedAt, windows }),
        credentialFingerprint: yield* credentialFingerprint({
          goKey: typeof go === "string" ? undefined : go.apiKey,
          copilot: typeof copilot === "string" ? undefined : Option.getOrUndefined(copilotAuth),
        }),
      };
    }
    const failed = [
      ...(go === "probeFailed" ? ["OpenCode Go"] : []),
      ...(copilot === "probeFailed" ? ["GitHub Copilot"] : []),
    ];
    return failed.length > 0
      ? makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: `${failed.join(" and ")} could not read usage.`,
        })
      : unsupported;
  }).pipe(
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode could not read its credentials.",
      }),
    ),
  );
});
