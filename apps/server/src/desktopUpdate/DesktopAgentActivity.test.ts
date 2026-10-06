import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OrchestrationV2ThreadShellSnapshot, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as DesktopAgentActivity from "./DesktopAgentActivity.ts";

const TOKEN = "desktop-bootstrap-token";

type ShellThread = {
  readonly activeRunId?: string | null;
  readonly activityRunStatus?: string | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<{ readonly kind: string }>;
};
const snapshotOf = (threads: ReadonlyArray<ShellThread>) =>
  ({
    schemaVersion: 1,
    snapshotSequence: 0,
    threads: threads.map((thread) => ({ activeRunId: null, activityRunStatus: null, ...thread })),
    archivedThreads: [],
  }) as never as OrchestrationV2ThreadShellSnapshot;

const configLayer = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, ...overrides } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-activity-test-" })),
    Layer.provide(NodeServices.layer),
  );

const request = (
  snapshot: Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>,
  options: {
    readonly mode?: "desktop" | "web";
    readonly authorization?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      Layer.mergeAll(
        configLayer({ mode: options.mode ?? "desktop", desktopBootstrapToken: TOKEN }),
        Layer.mock(Orchestrator.OrchestratorV2)({ getShellSnapshot: () => snapshot }),
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(DesktopAgentActivity.layer, {
          disableLogger: true,
        }),
      ),
      (web) =>
        Effect.promise(() =>
          web.handler(
            new Request(`http://127.0.0.1${DesktopAgentActivity.DESKTOP_AGENT_ACTIVITY_PATH}`, {
              headers: { authorization: options.authorization ?? `Bearer ${TOKEN}` },
            }),
            services,
          ),
        ),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.scoped);

describe("hasActiveAgentWork", () => {
  it("counts running turns and subagents that outlive their parent turn", () => {
    assert.isFalse(DesktopAgentActivity.hasActiveAgentWork(snapshotOf([{}, {}])));
    assert.isTrue(DesktopAgentActivity.hasActiveAgentWork(snapshotOf([{ activeRunId: "run-1" }])));
    assert.isTrue(
      DesktopAgentActivity.hasActiveAgentWork(snapshotOf([{ activityRunStatus: "waiting" }])),
    );
    assert.isTrue(
      DesktopAgentActivity.hasActiveAgentWork(
        snapshotOf([{ pendingBackgroundTasks: [{ kind: "subagent" }] }]),
      ),
    );
  });

  it("ignores long-lived background commands and monitors", () => {
    assert.isFalse(
      DesktopAgentActivity.hasActiveAgentWork(
        snapshotOf([{ pendingBackgroundTasks: [{ kind: "command" }, { kind: "monitor" }] }]),
      ),
    );
  });
});

describe("DesktopAgentActivity.layer", () => {
  it.effect("answers the launching desktop with the backend's agent activity", () =>
    Effect.gen(function* () {
      const busy = yield* request(Effect.succeed(snapshotOf([{ activeRunId: "run-1" }])));
      assert.equal(busy.status, 200);
      assert.deepEqual(yield* Effect.promise(() => busy.json()), { busy: true });

      const idle = yield* request(Effect.succeed(snapshotOf([{}])));
      assert.deepEqual(yield* Effect.promise(() => idle.json()), { busy: false });
    }),
  );

  it.effect("rejects other callers and servers the desktop did not launch", () =>
    Effect.gen(function* () {
      const idle = Effect.succeed(snapshotOf([]));
      assert.equal((yield* request(idle, { authorization: "Bearer wrong-token" })).status, 401);
      assert.equal((yield* request(idle, { authorization: "" })).status, 401);
      assert.equal((yield* request(idle, { mode: "web" })).status, 404);
    }),
  );

  it.effect("answers unavailable when activity cannot be read, so the desktop waits", () =>
    Effect.gen(function* () {
      const response = yield* request(
        Effect.fail(
          new Orchestrator.OrchestratorProjectionError({ threadId: ThreadId.make("thread-1") }),
        ),
      );
      assert.equal(response.status, 503);
    }),
  );
});
