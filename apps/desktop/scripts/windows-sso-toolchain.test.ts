import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { describe, expect, it } from "vite-plus/test";
import { selectWindowsSsoToolchain } from "./windows-sso-toolchain.mjs";

describe("Windows SSO compiler selection", () => {
  it("uses the native compiler host for native and cross builds", () => {
    expect(selectWindowsSsoToolchain("arm64", "arm64", ["arm64"])).toBe("arm64");
    expect(selectWindowsSsoToolchain("x64", "arm64", ["arm64"])).toBe("arm64_amd64");
    expect(selectWindowsSsoToolchain("arm64", "x64", ["x64"])).toBe("amd64_arm64");
    expect(selectWindowsSsoToolchain("x64", "x64", ["x64"])).toBe("amd64");
  });
  it("prefers ARM64 when available and falls back to an installed x64 compiler on ARM", () => {
    expect(selectWindowsSsoToolchain("arm64", "arm64", ["arm64", "x64"])).toBe("arm64");
    expect(selectWindowsSsoToolchain("arm64", "arm64", ["x64"])).toBe("amd64_arm64");
    expect(() => selectWindowsSsoToolchain("x64", "x64", ["arm64"])).toThrow();
  });
});

describe("Windows SSO helper packaging", () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The guard only applies off Windows hosts.
  it.skipIf(NodeOS.platform() === "win32")(
    "refuses to package without MSVC so a Linux-built Windows app cannot drop sign-in",
    () => {
      const script = NodePath.join(import.meta.dirname, "build-windows-sso.mjs");
      const output = NodePath.join(NodeOS.tmpdir(), "cody-sso-guard", "t3-windows-sso.exe");
      const run = NodeChildProcess.spawnSync(NodeProcess.execPath, [script, "--output", output], {
        encoding: "utf8",
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("package Windows Cody on a Windows host");
      expect(NodeChildProcess.spawnSync(NodeProcess.execPath, [script]).status).toBe(0);
    },
  );
});
