import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldTunnelPreview } from "./previewTunnel";

const environmentId = EnvironmentId.make("environment-1");
const base = {
  isElectron: true,
  serverSupportsTunnel: true,
  hasAuthorization: true,
  httpBaseUrl: "http://127.0.0.1:49152",
};
const saved = new BearerConnectionTarget({
  environmentId,
  label: "Devbox",
  connectionId: "saved:devbox",
});

describe("shouldTunnelPreview", () => {
  it("tunnels environments on other machines, whatever their URL looks like", () => {
    for (const target of [
      saved,
      new SshConnectionTarget({ environmentId, label: "Devbox", connectionId: "ssh:devbox" }),
      new RelayConnectionTarget({ environmentId, label: "Devbox" }),
    ]) {
      expect(shouldTunnelPreview({ ...base, target }), target._tag).toBe(true);
    }
  });

  it("loads the desktop's own backend directly only when it shares this machine's loopback", () => {
    const primary = (httpBaseUrl: string) =>
      new PrimaryConnectionTarget({
        environmentId,
        label: "This machine",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      });
    const wsl = new BearerConnectionTarget({
      environmentId,
      label: "WSL",
      connectionId: "local:wsl:Ubuntu",
    });
    for (const httpBaseUrl of [
      "http://127.0.0.1:4773",
      "http://localhost:4773",
      "http://[::1]:4773",
    ]) {
      expect(shouldTunnelPreview({ ...base, httpBaseUrl, target: primary(httpBaseUrl) })).toBe(
        false,
      );
    }
    // WSL-only mode binds the WSL NAT address, whose loopback is not this machine's.
    const natUrl = "http://172.30.75.225:4773";
    expect(shouldTunnelPreview({ ...base, httpBaseUrl: natUrl, target: primary(natUrl) })).toBe(
      true,
    );
    expect(shouldTunnelPreview({ ...base, httpBaseUrl: natUrl, target: wsl })).toBe(true);
    expect(shouldTunnelPreview({ ...base, target: wsl })).toBe(false);
  });

  it("falls back to direct loading without Electron, server support, or a ticketable session", () => {
    expect(shouldTunnelPreview({ ...base, target: saved, isElectron: false })).toBe(false);
    expect(shouldTunnelPreview({ ...base, target: saved, serverSupportsTunnel: false })).toBe(
      false,
    );
    expect(shouldTunnelPreview({ ...base, target: saved, hasAuthorization: false })).toBe(false);
    expect(shouldTunnelPreview({ ...base, target: null })).toBe(false);
  });
});
