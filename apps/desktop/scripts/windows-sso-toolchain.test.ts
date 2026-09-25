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
