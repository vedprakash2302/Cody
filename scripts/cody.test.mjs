import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assertClean, integrationCheckout, repositoryOf, resolveRemotes } from "./cody.mjs";

const test = NodeTest.test;
const Assert = NodeAssert;

function fixture(t) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cody-actions-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Cody test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Cody test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NodePath.join(root, "empty-config"),
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
  };
  const git = (cwd, ...args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (cwd, file, contents) => {
    NodeFS.writeFileSync(NodePath.join(cwd, file), contents);
    git(cwd, "add", file);
    git(cwd, "commit", "-m", `change ${file}`);
  };
  const repo = NodePath.join(root, "integration");
  git(root, "init", "-b", "personal/main", repo);
  write(repo, "base.txt", "base\n");
  return { root, repo, git, write, env };
}

test("finds integration from a feature worktree and resolves either remote convention", (t) => {
  const { root, repo, git } = fixture(t);
  const feature = NodePath.join(root, "feature");
  git(repo, "worktree", "add", "-b", "feat/test", feature);
  Assert.equal(NodePath.resolve(integrationCheckout(feature)), NodePath.resolve(repo));
  git(repo, "remote", "add", "origin", "https://github.com/pingdotgg/t3code.git");
  git(repo, "remote", "add", "personal", "git@github.com:vedprakash2302/Cody.git");
  Assert.deepEqual(resolveRemotes(feature), { personal: "personal", upstream: "origin" });
  git(repo, "remote", "rename", "origin", "t3");
  git(repo, "remote", "rename", "personal", "origin");
  Assert.deepEqual(resolveRemotes(feature), { personal: "origin", upstream: "t3" });
  git(repo, "remote", "set-url", "--push", "origin", "https://github.com/pingdotgg/t3code.git");
  Assert.throws(() => resolveRemotes(repo), /push URL/);
  Assert.equal(repositoryOf("https://github.com/vedprakash2302/Cody.git"), "vedprakash2302/cody");
  Assert.equal(repositoryOf("https://example.com/vedprakash2302/Cody.git"), null);
});

test("refuses dirty integration state", (t) => {
  const { repo } = fixture(t);
  NodeFS.writeFileSync(NodePath.join(repo, "base.txt"), "uncommitted\n");
  Assert.throws(() => assertClean(repo), /Commit or stash/);
});

test("sync retains personal commits, does not push, and leaves conflicts for resolution", (t) => {
  const { root, repo, git, write, env } = fixture(t);
  const fork = NodePath.join(root, "fork.git");
  const upstream = NodePath.join(root, "upstream");
  git(root, "clone", "--bare", repo, fork);
  git(root, "clone", repo, upstream);
  git(upstream, "switch", "-c", "main");
  git(repo, "remote", "add", "fork", fork);
  git(repo, "remote", "add", "t3", upstream);
  write(repo, "personal.txt", "personal\n");
  write(upstream, "upstream.txt", "upstream\n");
  const execute = () =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { syncCheckout } from ${JSON.stringify(new URL("./cody.mjs", import.meta.url).href)}; syncCheckout(${JSON.stringify(repo)}, {personal:'fork',upstream:'t3'});`,
      ],
      { env, encoding: "utf8" },
    );
  const first = execute();
  Assert.equal(first.status, 0, first.stderr);
  Assert.equal(NodeFS.readFileSync(NodePath.join(repo, "personal.txt"), "utf8"), "personal\n");
  Assert.equal(NodeFS.readFileSync(NodePath.join(repo, "upstream.txt"), "utf8"), "upstream\n");
  Assert.notEqual(git(repo, "rev-parse", "HEAD"), git(fork, "rev-parse", "personal/main"));
  write(repo, "base.txt", "personal change\n");
  write(upstream, "base.txt", "upstream change\n");
  const conflict = execute();
  Assert.notEqual(conflict.status, 0);
  Assert.match(conflict.stderr, /personal-fork skill/);
  Assert.equal(git(repo, "diff", "--name-only", "--diff-filter=U"), "base.txt");
});
