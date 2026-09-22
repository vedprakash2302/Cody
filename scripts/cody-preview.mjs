import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";
import { startRegistry } from "./cody-preview-registry.mjs";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function execute(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    maxBuffer: 32 * 1024 * 1024,
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
  return result.stdout;
}

function assertStopped(home) {
  const runtime = NodePath.join(home, "userdata/server-runtime.json");
  if (!NodeFS.existsSync(runtime)) return;
  const { pid } = JSON.parse(NodeFS.readFileSync(runtime, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid preview runtime PID.");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(
    `Stop the preview server in ${home} before refreshing its data. PID ${pid} is running.`,
  );
}

/** Snapshot a live source read-only, then remove credentials and resumable sessions from the copy. */
export function copyThreads(sourceHome, previewHome) {
  const source = NodePath.join(sourceHome, "userdata/state.sqlite");
  const targetDir = NodePath.join(previewHome, "userdata");
  const target = NodePath.join(targetDir, "state.sqlite");
  if (NodePath.resolve(sourceHome) === NodePath.resolve(previewHome))
    throw new Error("Source and preview homes must differ.");
  assertStopped(previewHome);
  if (!NodeFS.existsSync(source)) throw new Error(`No existing thread database at ${source}`);
  NodeFS.mkdirSync(targetDir, { recursive: true });
  if (NodeFS.realpathSync(NodePath.dirname(source)) === NodeFS.realpathSync(targetDir))
    throw new Error("Preview data cannot alias live data.");
  const temporary = `${target}.snapshot-${Date.now()}`;
  const live = new NodeSqlite.DatabaseSync(source, { readOnly: true });
  try {
    live.prepare("VACUUM INTO ?").run(temporary);
  } finally {
    live.close();
  }
  const snapshot = new NodeSqlite.DatabaseSync(temporary);
  try {
    const tables = new Set(
      snapshot
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    snapshot.exec("BEGIN");
    for (const table of [
      "auth_pairing_links",
      "auth_sessions",
      "provider_session_runtime",
      "projection_pending_approvals",
    ]) {
      if (tables.has(table)) snapshot.exec(`DELETE FROM ${table}`);
    }
    if (tables.has("projection_thread_sessions"))
      snapshot.exec("UPDATE projection_thread_sessions SET status='stopped', active_turn_id=NULL");
    if (tables.has("projection_threads"))
      snapshot.exec(
        "UPDATE projection_threads SET pending_approval_count=0,pending_user_input_count=0",
      );
    snapshot.exec("COMMIT");
  } finally {
    snapshot.close();
  }
  if (NodeFS.existsSync(target)) {
    const backup = NodePath.join(previewHome, `snapshot-backup-${Date.now()}`);
    NodeFS.mkdirSync(backup);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (NodeFS.existsSync(target + suffix))
        NodeFS.renameSync(target + suffix, NodePath.join(backup, `state.sqlite${suffix}`));
    }
    console.log(`Previous preview database backed up at ${backup}`);
  }
  NodeFS.renameSync(temporary, target);
  console.log(
    `Copied thread history and PR links into ${previewHome}. Preview authentication must be paired again. Production credentials and agent sessions were not copied.`,
  );
}

async function nativeWindows() {
  const wsl = Boolean(process.env.WSL_DISTRO_NAME);
  const powershell = wsl
    ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    : "powershell.exe";
  const runtimePath = NodePath.join(root, ".t3/userdata/server-runtime.json");
  if (!NodeFS.existsSync(runtimePath))
    throw new Error("Run Start Cody Dev first, then Build & Open Cody Preview.");
  const runtime = JSON.parse(NodeFS.readFileSync(runtimePath, "utf8"));
  process.kill(runtime.pid, 0);
  const serverEnv = NodeFS.readFileSync(`/proc/${runtime.pid}/environ`, "utf8").split("\0");
  const webUrl = serverEnv
    .find((entry) => entry.startsWith("VITE_DEV_SERVER_URL="))
    ?.slice("VITE_DEV_SERVER_URL=".length);
  if (!webUrl || !["localhost", "127.0.0.1"].includes(new URL(webUrl).hostname))
    throw new Error(
      "Could not find the local preview web URL. Run Start Cody Dev from this checkout.",
    );
  const stage = NodePath.join(root, ".t3", "native-stage");
  NodeFS.mkdirSync(stage, { recursive: true });
  // Include working changes and untracked source, but never local credentials or generated data.
  const files = execute("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    stdio: ["ignore", "pipe", "inherit"],
  })
    .toString()
    .split("\0")
    .filter(
      (file) =>
        file &&
        !file.startsWith(".repos/") &&
        !file
          .split("/")
          .some(
            (part) =>
              part === ".t3" ||
              part === "node_modules" ||
              part === ".env" ||
              (part.startsWith(".env.") && part !== ".env.example"),
          ) &&
        NodeFS.existsSync(NodePath.join(root, file)) &&
        NodeFS.lstatSync(NodePath.join(root, file)).isFile(),
    );
  const fileList = NodePath.join(stage, "files.txt");
  const archive = NodePath.join(stage, "source.tar");
  NodeFS.writeFileSync(fileList, files.join("\0") + "\0");
  execute("tar", ["--null", "-T", fileList, "-cf", archive]);
  const windowsPath = (path) =>
    wsl
      ? execute("wslpath", ["-w", path], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        }).trim()
      : path;
  const registry = await startRegistry();
  try {
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windowsPath(NodePath.join(root, "scripts/cody-preview-windows.ps1")),
      "-Archive",
      windowsPath(archive),
      "-WebUrl",
      webUrl,
      "-Registry",
      registry.url,
    ];
    await new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn(powershell, args, { cwd: root, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Windows preview exited with ${code}`)),
      );
    });
  } finally {
    registry.close();
  }
}

export async function main(action) {
  const home = NodePath.join(root, ".t3");
  if (action === "snapshot")
    return copyThreads(
      process.env.CODY_SOURCE_HOME || NodePath.join(NodeOS.homedir(), ".t3"),
      home,
    );
  if (action === "dev") {
    assertStopped(home);
    if (!NodeFS.existsSync(NodePath.join(home, "userdata/state.sqlite")))
      copyThreads(process.env.CODY_SOURCE_HOME || NodePath.join(NodeOS.homedir(), ".t3"), home);
    execute("vp", ["run", "dev", "--home-dir", home], {
      // eslint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher runs before dependencies are installed.
      shell: process.platform === "win32",
    });
    return;
  }
  if (action !== "native")
    throw new Error("Usage: node scripts/cody-preview.mjs <snapshot|dev|native>");
  if (process.env.WSL_DISTRO_NAME) return nativeWindows();
  if (!NodeFS.existsSync(NodePath.join(home, "userdata/state.sqlite")))
    copyThreads(process.env.CODY_SOURCE_HOME || NodePath.join(NodeOS.homedir(), ".t3"), home);
  assertStopped(home);
  execute("vp", ["run", "dev:desktop", "--home-dir", home], {
    // eslint-disable-next-line t3code/no-global-process-runtime -- Standalone preview launcher runs before dependencies are installed.
    shell: process.platform === "win32",
  });
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    await main(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
