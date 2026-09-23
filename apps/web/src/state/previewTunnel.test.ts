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
const base = { isElectron: true, serverSupportsTunnel: true, hasAuthorization: true };
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

  it("loads the desktop's own backends directly", () => {
    const primary = new PrimaryConnectionTarget({
      environmentId,
      label: "This machine",
      httpBaseUrl: "http://172.30.75.225:4773",
      wsBaseUrl: "ws://172.30.75.225:4773",
    });
    const wsl = new BearerConnectionTarget({
      environmentId,
      label: "WSL",
      connectionId: "local:wsl:Ubuntu",
    });
    expect(shouldTunnelPreview({ ...base, target: primary })).toBe(false);
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
