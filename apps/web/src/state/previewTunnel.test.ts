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
const base = { isElectron: true, serverSupportsTunnel: true };
const saved = new BearerConnectionTarget({
  environmentId,
  label: "Cloud PC",
  connectionId: "saved:cloud-pc",
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

  it("loads the desktop's own backends directly, including WSL on its NAT address", () => {
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

  it("stays unknown until the catalog and the remote server's capabilities load", () => {
    expect(shouldTunnelPreview({ ...base, target: undefined })).toBeUndefined();
    expect(shouldTunnelPreview({ ...base, target: saved, serverSupportsTunnel: undefined })).toBe(
      undefined,
    );
  });

  it("loads directly without Electron, server support, or a catalog entry", () => {
    expect(shouldTunnelPreview({ ...base, target: saved, isElectron: false })).toBe(false);
    expect(shouldTunnelPreview({ ...base, target: saved, serverSupportsTunnel: false })).toBe(
      false,
    );
    expect(shouldTunnelPreview({ ...base, target: null })).toBe(false);
  });
});
