import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
  resolveOriginPairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never builds a pairing link on the desktop app's private scheme", () => {
    expect(resolveOriginPairingUrl("t3code://app/settings/connections", "PAIRCODE")).toBeNull();
    expect(resolveOriginPairingUrl("https://t3.example.com/settings", "PAIRCODE")).toBe(
      "https://t3.example.com/pair#token=PAIRCODE",
    );
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});
