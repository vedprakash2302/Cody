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

// Cody's worktree pickers store full refs (`refs/remotes/t3/main`,
// `refs/heads/feature`). Upstream's base fetch must treat them like the short
// names its own pickers send, and keep a selected remote ref distinct from a
// local branch with the same short name.
it.layer(TestLayer)("worktree base fetch with full refs", (it) => {
  it.effect.each(["t3/main", "refs/remotes/t3/main"])(
    "creates a worktree at the fresh upstream commit for %s without fetching the fork",
    (refName) =>
      Effect.gen(function* () {
        const { cwd, root, initial, latest, git, driver } = yield* fixture;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        // An unavailable fork must not prevent fetching the selected upstream.
        yield* git(cwd, ["remote", "set-url", "origin", `${root}/missing`]);
        const base = yield* workflow.fetchWorktreeBaseCommit({ cwd, refName });
        assert.deepEqual(base, { commitSha: latest, remoteRefName: "t3/main" });
        yield* driver.createWorktree({
          cwd,
          refName: base!.commitSha,
          newRefName: "test/fresh",
          baseRefName: `refs/remotes/${base!.remoteRefName}`,
          path: `${root}/worktree`,
        });
        assert.equal(yield* git(`${root}/worktree`, ["rev-parse", "HEAD"]), latest);
        assert.equal(yield* git(cwd, ["rev-parse", "main"]), initial);
        assert.equal(yield* git(cwd, ["rev-parse", "origin/main"]), initial);
      }),
  );

  it.effect.each([true, false])(
    "keeps a selected remote ref apart from a same-named local branch with refresh %s",
    (refresh) =>
      Effect.gen(function* () {
        const { cwd, root, initial, latest, git, driver } = yield* fixture;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        // A local branch named like the remote ref, pointing elsewhere.
        yield* git(cwd, ["branch", "t3/main", latest]);
        yield* git(cwd, ["update-ref", "refs/heads/t3/main", initial]);
        const selection = worktreeBaseRef({ name: "t3/main", isRemote: true });
        const base = refresh
          ? yield* workflow.fetchWorktreeBaseCommit({ cwd, refName: selection })
          : null;
        if (refresh) assert.equal(base?.commitSha, latest);
        yield* driver.createWorktree({
          cwd,
          refName: base?.commitSha ?? selection,
          baseRefName: selection,
          newRefName: "test/collision",
          path: `${root}/collision`,
        });
        assert.equal(
          yield* git(`${root}/collision`, ["rev-parse", "HEAD"]),
          refresh ? latest : initial,
        );
        assert.equal(yield* git(cwd, ["config", "branch.test/collision.t3-merge-base"]), "main");
      }),
  );

  it.effect("fetches a full local ref's branch from origin like its short name", () =>
    Effect.gen(function* () {
      const { cwd, fork, initial, latest, git } = yield* fixture;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* git(cwd, ["branch", "feature/topic", initial]);
      yield* git(cwd, ["push", fork, `${latest}:refs/heads/feature/topic`]);
      const base = yield* workflow.fetchWorktreeBaseCommit({
        cwd,
        refName: worktreeBaseRef({ name: "feature/topic", isRemote: false }),
      });
      assert.deepEqual(base, { commitSha: latest, remoteRefName: "origin/feature/topic" });
      assert.equal(yield* git(cwd, ["rev-parse", "refs/heads/feature/topic"]), initial);
    }),
  );

  it.effect("matches configured remote names and preserves branch slashes", () =>
    Effect.gen(function* () {
      const { cwd, remote, latest, git } = yield* fixture;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* git(cwd, ["remote", "add", "t3-team", remote]);
      yield* git(cwd, ["push", remote, `${latest}:refs/heads/feature/topic`]);
      const base = yield* workflow.fetchWorktreeBaseCommit({
        cwd,
        refName: "refs/remotes/t3-team/feature/topic",
      });
      assert.deepEqual(base, { commitSha: latest, remoteRefName: "t3-team/feature/topic" });
    }),
  );
});
