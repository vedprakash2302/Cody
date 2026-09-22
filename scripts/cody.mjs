import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const fork = "vedprakash2302/cody";
const upstream = "pingdotgg/t3code";
const integrationBranch = "personal/main";

function run(command, args, cwd, capture = false) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    // Vite+ installs a cmd shim on Windows. Its arguments below are fixed by this script.
    // eslint-disable-next-line t3code/no-global-process-runtime -- This dependency-free CLI also runs before vp install.
    shell: process.platform === "win32" && command === "vp",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed${capture ? `: ${result.stderr.trim()}` : ". See the output above."}`,
    );
  }
  return capture ? result.stdout.trim() : "";
}

const git = (cwd, ...args) => run("git", args, cwd, true);

/** Identify GitHub remotes independently of the local naming convention. */
export function repositoryOf(url) {
  return (
    /^(?:https?:\/\/github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+\/[^/]+?)\/?$/i
      .exec(url.trim().replace(/\.git\/?$/i, ""))?.[1]
      ?.toLowerCase() ?? null
  );
}

export function resolveRemotes(cwd) {
  const remotes = git(cwd, "remote")
    .split("\n")
    .filter(Boolean)
    .map((name) => ({
      name,
      repository: repositoryOf(git(cwd, "remote", "get-url", name)),
    }));
  const pick = (repository) => {
    const matches = remotes.filter((remote) => remote.repository === repository);
    if (matches.length !== 1)
      throw new Error(
        `Expected one remote for ${repository}; found ${matches.length}. Check git remote -v.`,
      );
    return matches[0].name;
  };
  const personal = pick(fork);
  if (repositoryOf(git(cwd, "remote", "get-url", "--push", personal)) !== fork) {
    throw new Error("The Cody remote's push URL does not point to the Cody fork.");
  }
  return { personal, upstream: pick(upstream) };
}

/** Locate the integration checkout without switching the caller's feature branch. */
export function integrationCheckout(cwd) {
  const worktrees = git(cwd, "worktree", "list", "--porcelain", "-z").split("\0\0");
  const matches = worktrees
    .map((entry) => entry.split("\0"))
    .filter((fields) => fields.includes(`branch refs/heads/${integrationBranch}`));
  const path = matches[0]?.find((field) => field.startsWith("worktree "))?.slice(9);
  if (matches.length !== 1 || !path) {
    throw new Error(
      "Open personal/main in an integration worktree first. No feature checkout was changed.",
    );
  }
  return path;
}

export function assertClean(cwd) {
  if (git(cwd, "status", "--porcelain")) {
    throw new Error(`Commit or stash changes in ${cwd} before updating Cody.`);
  }
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
  ]) {
    if (NodeFS.existsSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-path", marker))) {
      throw new Error(`Finish the existing Git operation in ${cwd} before updating Cody.`);
    }
  }
}

/** Merge fetched upstream into the local integration branch, preserving personal commits. */
export function syncCheckout(cwd, remotes) {
  assertClean(cwd);
  run(
    "git",
    [
      "fetch",
      "--no-tags",
      remotes.personal,
      `refs/heads/${integrationBranch}:refs/remotes/${remotes.personal}/${integrationBranch}`,
    ],
    cwd,
  );
  run("git", ["merge", "--ff-only", `refs/remotes/${remotes.personal}/${integrationBranch}`], cwd);
  run(
    "git",
    [
      "fetch",
      "--no-tags",
      remotes.upstream,
      `refs/heads/main:refs/remotes/${remotes.upstream}/main`,
    ],
    cwd,
  );
  try {
    run(
      "git",
      [
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        "merge: sync upstream main",
        `refs/remotes/${remotes.upstream}/main`,
      ],
      cwd,
    );
  } catch (error) {
    throw new Error(
      `${error.message}\nResolve the merge in ${cwd} with the personal-fork skill. Prefer upstream where it covers the personal fix, then rerun Sync Cody. Nothing was pushed.`,
      { cause: error },
    );
  }
}

function check(cwd) {
  const regressionFiles = JSON.parse(
    NodeFS.readFileSync(NodePath.join(cwd, "scripts", "personal-fixes.json"), "utf8"),
  );
  run(process.execPath, ["--test", "scripts/cody.test.mjs"], cwd);
  run("vp", ["test", "run", ...regressionFiles], cwd);
}

/** Run project actions in one integration checkout with a persistent isolated dev home. */
export function main(action, cwd = process.cwd()) {
  if (action === "check") return check(cwd);
  if (!["sync", "dev", "release"].includes(action)) {
    throw new Error("Usage: node scripts/cody.mjs <sync|dev|release|check>");
  }
  const root = integrationCheckout(cwd);
  // Feature worktrees may carry older scripts. Always execute the integration version.
  const entry = NodePath.join(root, "scripts", "cody.mjs");
  if (NodeFS.realpathSync(entry) !== NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))) {
    return run(process.execPath, [entry, action], root);
  }
  if (action === "dev") {
    assertDevStopped(root);
    console.log(
      `Starting Cody from ${root}. Open the printed localhost pairing URL in Windows Chrome.`,
    );
    return run("vp", ["run", "dev", "--home-dir", NodePath.join(root, ".t3")], root);
  }
  const remotes = resolveRemotes(root);
  assertClean(root);
  if (action === "sync") assertDevStopped(root);
  const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const lock = NodePath.join(commonDir, "cody-maintenance.lock");
  try {
    NodeFS.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `Another Cody action owns ${lock}. If it crashed, remove this directory after confirming no sync or release is running.`,
      { cause: error },
    );
  }
  try {
    if (action === "sync") syncCheckout(root, remotes);
    else run("gh", ["auth", "status"], root);
    run("vp", ["install", "--frozen-lockfile"], root);
    check(root);
    assertClean(root);
    if (action === "release") {
      run("git", ["push", remotes.personal, `HEAD:refs/heads/${integrationBranch}`], root);
      run(
        "gh",
        [
          "workflow",
          "run",
          "personal-build.yml",
          "--repo",
          "vedprakash2302/Cody",
          "--ref",
          integrationBranch,
        ],
        root,
      );
      console.log(
        "Build requested: https://github.com/vedprakash2302/Cody/actions/workflows/personal-build.yml\nThe workflow publishes downloads when all platform jobs succeed. Installation is manual.",
      );
    } else {
      console.log(
        `Cody source is updated and checked in ${root}. Nothing was pushed. Restart Cody Dev to use the updated source. Installed apps update only after a release is built and installed.`,
      );
    }
  } finally {
    NodeFS.rmdirSync(lock);
  }
}

function assertDevStopped(root) {
  const runtimePath = NodePath.join(root, ".t3", "userdata", "server-runtime.json");
  if (!NodeFS.existsSync(runtimePath)) return;
  const { pid } = JSON.parse(NodeFS.readFileSync(runtimePath, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(
    `Cody Dev is already running with PID ${pid}. Stop its terminal process before starting or syncing again.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
