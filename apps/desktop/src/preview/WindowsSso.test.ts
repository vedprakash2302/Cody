import { describe, expect, it, vi } from "vite-plus/test";
import type { Session } from "electron";

import {
  createWindowsSsoHandler,
  installWindowsSso,
  isWindowsSsoUrl,
  parseWindowsSsoResponse,
} from "./WindowsSso.ts";

const login = "https://login.microsoftonline.com/tenant/oauth2/authorize?sso_nonce=test";
const auth = {
  headers: {
    "x-ms-DeviceCredential": "device-proof",
    "x-ms-RefreshTokenCredential": "account-proof",
  },
  cookies: ["sso=test-proof"],
};
const request = (url = login, requestHeaders: Record<string, string> = {}, id = 1) => ({
  id,
  url,
  requestHeaders,
  resourceType: "mainFrame",
});

describe("Windows browser SSO", () => {
  it("discards proofs if cancellation happens during the final settings read", async () => {
    const finalRead = Promise.withResolvers<boolean>();
    const reading = Promise.withResolvers<void>();
    const enabled = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => {
        reading.resolve();
        return finalRead.promise;
      });
    const handler = createWindowsSsoHandler(async () => auth, enabled);
    const pending = handler.handle(request());
    await reading.promise;
    handler.finish(1);
    finalRead.resolve(true);
    expect(await pending).toEqual({});
    // If cleanup was undone, these same headers would be removed on reuse.
    expect(await handler.handle(request("https://example.com/", auth.headers))).toEqual(
      auth.headers,
    );
  });

  it("does not start the helper after cancellation during the first settings read", async () => {
    const setting = Promise.withResolvers<boolean>();
    const getAuth = vi.fn(async () => auth);
    const handler = createWindowsSsoHandler(getAuth, () => setting.promise);
    const pending = handler.handle(request());
    handler.finish(1);
    setting.resolve(true);
    expect(await pending).toEqual({});
    expect(getAuth).not.toHaveBeenCalled();
  });
  it("enables and disables existing sessions without restarting", async () => {
    let enabled = false;
    const getAuth = vi.fn(async () => auth);
    const handler = createWindowsSsoHandler(getAuth, async () => enabled);
    expect(await handler.handle(request())).toEqual({});
    expect(getAuth).not.toHaveBeenCalled();
    enabled = true;
    const headers = await handler.handle(request());
    expect(headers).toHaveProperty("x-ms-DeviceCredential");
    enabled = false;
    expect(await handler.handle(request(login, headers))).toEqual({});
    expect(getAuth).toHaveBeenCalledOnce();
  });

  it("discards a proof when disabled during the Windows call", async () => {
    let enabled = true;
    const result = Promise.withResolvers<typeof auth>();
    const started = Promise.withResolvers<void>();
    const handler = createWindowsSsoHandler(
      () => {
        started.resolve();
        return result.promise;
      },
      async () => enabled,
    );
    const pending = handler.handle(request());
    await started.promise;
    enabled = false;
    result.resolve(auth);
    expect(await pending).toEqual({});
  });
  it("leaves incognito, other platforms, and disabled sessions alone", () => {
    const untouched = new Proxy({} as Session, {
      get() {
        throw new Error("Session should not be accessed");
      },
    });
    installWindowsSso(untouched, false, "win32", "C:\\helper.exe");
    installWindowsSso(untouched, true, "linux", "C:\\helper.exe");
    installWindowsSso(untouched, true, "darwin", "C:\\helper.exe");
    installWindowsSso(untouched, true, "win32", undefined);
    installWindowsSso(untouched, true, "win32", "relative.exe");
  });
  it("accepts only the exact HTTPS authority", () => {
    expect(isWindowsSsoUrl(login)).toBe(true);
    for (const url of [
      "http://login.microsoftonline.com/",
      "https://login.microsoftonline.com.evil.test/",
      "https://evil.test/login.microsoftonline.com",
      "https://login.microsoftonline.com:444/",
      "https://user:pass@login.microsoftonline.com/",
      "https://device.login.microsoftonline.com/",
      "https://dev.azure.com/",
      "not a URL",
    ])
      expect(isWindowsSsoUrl(url)).toBe(false);
  });

  it("converts Windows cookie attributes to request headers and cookie pairs", () => {
    expect(
      parseWindowsSsoResponse(
        JSON.stringify({
          ok: true,
          cookies: [
            { name: "x-ms-DeviceCredential", data: "proof; path=/; secure; httponly" },
            { name: "sso", data: "cookie-proof; path=/; secure" },
          ],
        }),
      ),
    ).toEqual({ headers: { "x-ms-DeviceCredential": "proof" }, cookies: ["sso=cookie-proof"] });
  });

  it("rejects malformed output without including credential values in errors", () => {
    expect(() => parseWindowsSsoResponse("secret-credential-not-json")).toThrow(
      "Invalid Windows SSO response",
    );
    for (const output of [
      { ok: false, code: "secret-value" },
      { ok: true, cookies: [{ name: "x-ms-proof", data: "secret-value\r\nInjected: header" }] },
      { ok: true, cookies: [{ name: "Cookie: invalid", data: "secret-value" }] },
      {
        ok: true,
        cookies: [
          { name: "sso", data: "a" },
          { name: "SSO", data: "b" },
        ],
      },
      { ok: true, cookies: [null] },
    ]) {
      expect(() => parseWindowsSsoResponse(JSON.stringify(output))).toThrow(/Windows SSO/);
    }
  });

  it("preserves existing session cookies and strips proofs on an unrelated redirect", async () => {
    const getAuth = vi.fn(async () => auth);
    const handler = createWindowsSsoHandler(getAuth);
    const headers = await handler.handle(
      request(login, { Cookie: "session=abc", Accept: "text/html" }),
    );
    expect(headers).toEqual({
      ...auth.headers,
      Cookie: "session=abc; sso=test-proof",
      Accept: "text/html",
    });
    // Chromium can normalize header casing between redirects.
    const redirected = await handler.handle(
      request("https://dev.azure.com/", {
        "X-MS-DEVICECREDENTIAL": headers["x-ms-DeviceCredential"]!,
        "x-ms-RefreshTokenCredential": headers["x-ms-RefreshTokenCredential"]!,
        cookie: headers.Cookie!,
        Accept: headers.Accept!,
      }),
    );
    expect(redirected).toEqual({ cookie: "session=abc", Accept: "text/html" });
    expect(getAuth).toHaveBeenCalledExactlyOnceWith(login);
  });

  it("fetches fresh proofs for each sign-in redirect without accumulating cookies", async () => {
    const getAuth = vi
      .fn()
      .mockResolvedValueOnce(auth)
      .mockResolvedValueOnce({
        headers: { "x-ms-DeviceCredential": "fresh-proof" },
        cookies: ["sso=fresh"],
      });
    const handler = createWindowsSsoHandler(getAuth);
    const headers = await handler.handle(request());
    expect(await handler.handle(request(`${login}2`, headers))).toEqual({
      "x-ms-DeviceCredential": "fresh-proof",
      Cookie: "sso=fresh",
    });
    expect(getAuth).toHaveBeenLastCalledWith(`${login}2`);
  });

  it("does not use Windows credentials for fetches or non-Microsoft pages", async () => {
    const getAuth = vi.fn(async () => auth);
    const handler = createWindowsSsoHandler(getAuth);
    await handler.handle({ ...request(), resourceType: "xhr" });
    await handler.handle(request("https://example.com/"));
    expect(getAuth).not.toHaveBeenCalled();
    await handler.handle({ ...request(), resourceType: "subFrame" });
    expect(getAuth).toHaveBeenCalledOnce();
  });

  it("continues normal sign-in when the helper fails", async () => {
    const handler = createWindowsSsoHandler(async () => {
      throw new Error("unavailable");
    });
    expect(await handler.handle(request(login, { Cookie: "session=abc" }))).toEqual({
      Cookie: "session=abc",
    });
  });

  it("removes stale proofs even when a redirect's credential lookup fails", async () => {
    const getAuth = vi.fn().mockResolvedValueOnce(auth).mockRejectedValueOnce(new Error("timeout"));
    const handler = createWindowsSsoHandler(getAuth);
    const headers = await handler.handle(request(login, { Cookie: "session=abc" }));
    expect(await handler.handle(request(`${login}2`, headers))).toEqual({ Cookie: "session=abc" });
  });

  it("keeps concurrent navigation credentials separate", async () => {
    const handler = createWindowsSsoHandler(async () => auth);
    const first = await handler.handle(request(login, {}, 1));
    const second = await handler.handle(request(login, {}, 2));
    handler.finish(1);
    expect(await handler.handle(request("https://dev.azure.com/", second, 2))).toEqual({});
    expect(first).toHaveProperty("x-ms-DeviceCredential");
  });

  it("does not attach proofs after a request was cancelled", async () => {
    const result = Promise.withResolvers<typeof auth>();
    const handler = createWindowsSsoHandler(() => result.promise);
    const pending = handler.handle(request());
    handler.finish(1);
    result.resolve(auth);
    expect(await pending).toEqual({});
  });

  it("limits concurrent Windows processes and recovers capacity when they finish", async () => {
    const result = Promise.withResolvers<typeof auth>();
    const getAuth = vi.fn(() => result.promise);
    const handler = createWindowsSsoHandler(getAuth);
    const pending = Array.from({ length: 4 }, (_, id) => handler.handle(request(login, {}, id)));
    expect(await handler.handle(request(login, {}, 5))).toEqual({});
    expect(getAuth).toHaveBeenCalledTimes(4);
    result.resolve(auth);
    await Promise.all(pending);
    await handler.handle(request(login, {}, 6));
    expect(getAuth).toHaveBeenCalledTimes(5);
  });
});
