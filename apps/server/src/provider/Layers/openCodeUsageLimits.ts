import * as NodeOS from "node:os";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

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

const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

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

type ProbeResult = ReadonlyArray<ServerProviderUsageWindow> | "unsupported" | "probeFailed";

const readGoWindows = Effect.fn("readGoWindows")(function* (apiKey: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
      HttpClientRequest.bearerToken(apiKey),
    ),
  );
  // A valid Zen key can exist without a Go subscription.
  if (response.status === 403) return "unsupported" as const;
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
  );
  return [
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
  ] satisfies ReadonlyArray<ServerProviderUsageWindow>;
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

const guardProbe = <E, R>(probe: Effect.Effect<ProbeResult, E, R>) =>
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
      path.join(env.HOME || env.USERPROFILE || NodeOS.homedir(), ".local", "share");
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
    const goAuth = decodeApiAuth(auth["opencode-go"]);
    // OpenCode overlays stored API credentials after environment credentials.
    const goKey = (Option.isSome(goAuth) ? goAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    const copilotAuth = decodeCopilotAuth(auth["github-copilot"]);

    const probes = yield* Effect.all(
      {
        "OpenCode Go": goKey
          ? guardProbe(readGoWindows(goKey))
          : Effect.succeed("unsupported" as const),
        "GitHub Copilot": Option.isSome(copilotAuth)
          ? guardProbe(readCopilotWindows(copilotAuth.value))
          : Effect.succeed("unsupported" as const),
      },
      { concurrency: "unbounded" },
    );
    const results: ReadonlyArray<readonly [string, ProbeResult]> = Object.entries(probes);
    const windows = results.flatMap(([, result]) => (typeof result === "string" ? [] : result));
    if (windows.length > 0) return makeUsageLimits({ checkedAt, windows });
    const failed = results.filter(([, result]) => result === "probeFailed").map(([name]) => name);
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
