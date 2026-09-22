import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { worktreeBaseRef } from "@t3tools/shared/git";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";

const TestLayer = GitWorkflowService.layer.pipe(
  Layer.provide(Layer.mock(GitManager.GitManager)({})),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "worktree-base-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "worktree-base-test-" });
  const cwd = path.join(root, "repo");
  const remote = path.join(root, "upstream");
  const fork = path.join(root, "fork");
  for (const dir of [cwd, remote, fork]) yield* fs.makeDirectory(dir);
  const git = (dir: string, args: ReadonlyArray<string>) =>
    driver
      .execute({ operation: "test.worktreeBase", cwd: dir, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* git(cwd, ["init", "-b", "main"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* git(cwd, ["config", "user.email", "test@example.com"]);
  yield* git(cwd, ["commit", "--allow-empty", "-m", "initial"]);
  const initial = yield* git(cwd, ["rev-parse", "HEAD"]);
  yield* git(remote, ["init", "--bare"]);
  yield* git(fork, ["init", "--bare"]);
  yield* git(cwd, ["remote", "add", "origin", fork]);
  yield* git(cwd, ["remote", "add", "t3", remote]);
  yield* git(cwd, ["push", "origin", "main"]);
  yield* git(cwd, ["push", "t3", "main"]);
  yield* git(cwd, ["checkout", "-b", "peer"]);
  yield* git(cwd, ["commit", "--allow-empty", "-m", "upstream change"]);
  const latest = yield* git(cwd, ["rev-parse", "HEAD"]);
  // Push by URL so the local t3/main tracking ref stays stale.
  yield* git(cwd, ["push", remote, "HEAD:refs/heads/main"]);
  yield* git(cwd, ["checkout", "main"]);
  return { cwd, root, remote, fork, initial, latest, git, driver };
});

it.layer(TestLayer)("worktree base preparation", (it) => {
  it.effect.each(["t3/main", "refs/remotes/t3/main"])(
    "creates a worktree at the fresh upstream commit for %s without fetching the fork",
    (refName) =>
      Effect.gen(function* () {
        const { cwd, root, initial, latest, git, driver } = yield* fixture;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        // An unavailable fork must not prevent fetching the selected upstream.
        yield* git(cwd, ["remote", "set-url", "origin", `${root}/missing`]);
        const base = yield* workflow.prepareWorktreeBase({ cwd, refName, startFromOrigin: true });
        assert.deepEqual(base, {
          refName: latest,
          fetchStatus: "done",
          detail: `t3/main at ${latest.slice(0, 7)}`,
        });
        yield* driver.createWorktree({
          cwd,
          refName: base.refName,
          newRefName: "test/fresh",
          baseRefName: refName,
          path: `${root}/worktree`,
        });
        assert.equal(yield* git(`${root}/worktree`, ["rev-parse", "HEAD"]), latest);
        assert.equal(yield* git(cwd, ["rev-parse", "main"]), initial);
        assert.equal(yield* git(cwd, ["rev-parse", "origin/main"]), initial);
      }),
  );

  it.effect("uses a cached remote ref without fetching when refresh is off", () =>
    Effect.gen(function* () {
      const { cwd, initial, git } = yield* fixture;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const base = yield* workflow.prepareWorktreeBase({
        cwd,
        refName: "t3/main",
        startFromOrigin: false,
      });
      assert.equal(base.fetchStatus, "skipped");
      assert.equal(yield* git(cwd, ["rev-parse", base.refName]), initial);
    }),
  );

  it.effect.each(["deleted", "unreachable"])(
    "rejects an explicit remote base that is %s despite its cached commit",
    (reason) =>
      Effect.gen(function* () {
        const { cwd, root, remote, initial, git } = yield* fixture;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        if (reason === "deleted") {
          yield* git(remote, ["update-ref", "-d", "refs/heads/main"]);
        } else {
          yield* git(cwd, ["remote", "set-url", "t3", `${root}/missing`]);
        }
        const error = yield* workflow
          .prepareWorktreeBase({
            cwd,
            refName: "t3/main",
            startFromOrigin: true,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
        assert.equal(yield* git(cwd, ["rev-parse", "t3/main"]), initial);
      }),
  );

  it.effect.each(["feature/topic", "t3/main", "origin/topic"])(
    "preserves local branch semantics for %s",
    (refName) =>
      Effect.gen(function* () {
        const { cwd, fork, initial, latest, git } = yield* fixture;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* git(cwd, ["branch", refName, initial]);
        yield* git(cwd, ["push", "origin", `${initial}:refs/heads/${refName}`]);
        yield* git(cwd, ["push", fork, `${latest}:refs/heads/${refName}`]);
        yield* git(cwd, ["push", "origin", `${initial}:refs/heads/topic`]);
        const base = yield* workflow.prepareWorktreeBase({ cwd, refName, startFromOrigin: true });
        assert.equal(base.refName, latest);
        assert.equal(base.detail, `origin/${refName} at ${latest.slice(0, 7)}`);
        assert.equal(yield* git(cwd, ["rev-parse", `refs/heads/${refName}`]), initial);
      }),
  );

  it.effect.each([true, false])(
    "preserves a selected remote namespace with refresh %s",
    (refresh) =>
      Effect.gen(function* () {
        const { cwd, root, initial, latest, git, driver } = yield* fixture;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* git(cwd, ["branch", "t3/main", latest]);
        const selection = worktreeBaseRef({ name: "t3/main", isRemote: true });
        const base = yield* workflow.prepareWorktreeBase({
          cwd,
          refName: selection,
          startFromOrigin: refresh,
        });
        yield* driver.createWorktree({
          cwd,
          refName: base.refName,
          baseRefName: selection,
          newRefName: "test/collision",
          path: `${root}/collision`,
        });
        assert.equal(
          yield* git(`${root}/collision`, ["rev-parse", "HEAD"]),
          refresh ? latest : initial,
        );
        assert.equal(yield* git(cwd, ["config", "branch.test/collision.gh-merge-base"]), "main");
      }),
  );

  it.effect("matches configured remote names and preserves branch slashes", () =>
    Effect.gen(function* () {
      const { cwd, remote, latest, git } = yield* fixture;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* git(cwd, ["remote", "add", "t3-team", remote]);
      yield* git(cwd, ["push", remote, `${latest}:refs/heads/feature/topic`]);
      const base = yield* workflow.prepareWorktreeBase({
        cwd,
        refName: "t3-team/feature/topic",
        startFromOrigin: true,
      });
      assert.equal(base.refName, latest);
      assert.equal(base.detail, `t3-team/feature/topic at ${latest.slice(0, 7)}`);
    }),
  );

  it.effect.each(["missing remote", "local-only branch"])(
    "retains the local-base fallback for %s",
    (reason) =>
      Effect.gen(function* () {
        const { cwd, git } = yield* fixture;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* git(cwd, ["branch", "local-only"]);
        if (reason === "missing remote") yield* git(cwd, ["remote", "remove", "origin"]);
        const base = yield* workflow.prepareWorktreeBase({
          cwd,
          refName: "local-only",
          startFromOrigin: true,
        });
        assert.equal(base.refName, "local-only");
        assert.equal(base.fetchStatus, reason === "missing remote" ? "skipped" : "warning");
      }),
  );
});
