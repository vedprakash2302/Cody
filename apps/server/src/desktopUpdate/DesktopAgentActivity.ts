import * as NodeCrypto from "node:crypto";

import type { OrchestrationV2ThreadShellSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

export const DESKTOP_AGENT_ACTIVITY_PATH = "/api/desktop/agent-activity";

/**
 * True while any agent has work in progress: an active or waking run, or a
 * subagent still running after its parent's turn ended. Background commands
 * and monitors do not count; dev servers and watchers can run for days.
 */
export function hasActiveAgentWork(
  snapshot: Pick<OrchestrationV2ThreadShellSnapshot, "threads" | "archivedThreads">,
): boolean {
  return [...snapshot.threads, ...snapshot.archivedThreads].some(
    (thread) =>
      thread.activeRunId !== null ||
      (thread.activityRunStatus ?? null) !== null ||
      (thread.pendingBackgroundTasks ?? []).some(
        (task) => task.kind === "subagent" || task.kind === "background_task",
      ),
  );
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && NodeCrypto.timingSafeEqual(given, expected);
}

/**
 * Lets the desktop app that launched this backend ask whether an agent is
 * working, so Cody restarts into an update only while every backend is idle.
 * Authenticated with the launch's bootstrap token. A failed read answers 503,
 * which the desktop treats as busy.
 */
export const layer = HttpRouter.add(
  "GET",
  DESKTOP_AGENT_ACTIVITY_PATH,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const token = config.desktopBootstrapToken;
    if (config.mode !== "desktop" || token === undefined) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!bearerMatches(request.headers.authorization, token)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    const engine = yield* Orchestrator.OrchestratorV2;
    return yield* engine.getShellSnapshot({ unsettledOnly: true }).pipe(
      Effect.map((snapshot) =>
        HttpServerResponse.jsonUnsafe({ busy: hasActiveAgentWork(snapshot) }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read agent activity for the desktop app", {
          cause: String(cause),
        }).pipe(Effect.as(HttpServerResponse.text("Unavailable", { status: 503 }))),
      ),
    );
  }),
);
