import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { selectWindowsSsoToolchain } from "./windows-sso-toolchain.mjs";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native compiler launcher.
if (process.platform === "win32") {
  const { values } = NodeUtil.parseArgs({
    options: {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Defaults to the compiler host architecture.
      arch: { type: "string", default: process.arch },
      output: { type: "string" },
    },
  });
  if (values.arch !== "x64" && values.arch !== "arm64")
    throw new Error("Unsupported Windows SSO architecture");
  const root = NodeURL.fileURLToPath(
    new URL("../../../native/windows-browser-sso/", import.meta.url),
  );
  const source = NodePath.join(root, "main.cpp");
  const output = NodePath.resolve(
    values.output ?? NodePath.join(root, "build", values.arch, "t3-windows-sso.exe"),
  );
  const machine = values.arch === "arm64" ? 0xaa64 : 0x8664;
  const matches = (file) => {
    const bytes = NodeFS.readFileSync(file);
    return (
      bytes.readUInt16LE(0) === 0x5a4d &&
      bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) === machine
    );
  };
  try {
    if (
      matches(output) &&
      NodeFS.statSync(output).mtimeMs >=
        Math.max(
          NodeFS.statSync(source).mtimeMs,
          NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
        )
    )
      process.exit(0);
  } catch {
    /* First build. */
  }
  const vswhere = NodePath.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const install = NodeChildProcess.execFileSync(
    vswhere,
    ["-latest", "-products", "*", "-property", "installationPath"],
    { encoding: "utf8" },
  ).trim();
  if (!install)
    throw new Error("Windows SSO requires Visual Studio C++ build tools and the Windows SDK");
  const toolsets = NodePath.join(install, "VC", "Tools", "MSVC");
  const selectedVersion = NodeFS.readFileSync(
    NodePath.join(install, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt"),
    "utf8",
  ).trim();
  const installedHosts = ["arm64", "x64"].filter(
    (host) =>
      selectedVersion &&
      NodeFS.existsSync(
        NodePath.join(
          toolsets,
          selectedVersion,
          "bin",
          `Host${host === "arm64" ? "ARM64" : "x64"}`,
          values.arch,
          "cl.exe",
        ),
      ),
  );
  // PROCESSOR_ARCHITEW6432 reports the native architecture under x64 emulation.
  const nativeHost =
    (process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE)?.toLowerCase() ===
    "arm64"
      ? "arm64"
      : "x64";
  const toolchain = selectWindowsSsoToolchain(values.arch, nativeHost, installedHosts);
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  const temp = NodeFS.mkdtempSync(NodePath.join(NodePath.dirname(output), "sso-build-"));
  const quote = (value) => {
    if (/["%\r\n]/.test(value)) throw new Error("Unsupported compiler path");
    return `"${value}"`;
  };
  try {
    const script = NodePath.join(temp, "build.cmd");
    NodeFS.writeFileSync(
      script,
      [
        "@echo off",
        `call ${quote(NodePath.join(install, "VC", "Auxiliary", "Build", "vcvarsall.bat"))} ${toolchain} >nul`,
        "if errorlevel 1 exit /b 1",
        `cl /nologo /O2 /W4 /WX /MT /EHsc ${quote(source)} /Fe:${quote(NodePath.join(temp, "helper.exe"))} /Fo:${quote(NodePath.join(temp, "helper.obj"))} /link ole32.lib`,
        "exit /b %errorlevel%",
      ].join("\r\n"),
    );
    NodeChildProcess.execFileSync("cmd.exe", ["/d", "/c", script], { cwd: temp, stdio: "inherit" });
    const binary = NodePath.join(temp, "helper.exe");
    if (!matches(binary)) throw new Error("Windows SSO helper has the wrong architecture");
    NodeFS.copyFileSync(binary, output);
  } finally {
    NodeFS.rmSync(temp, { recursive: true, force: true });
  }
}
