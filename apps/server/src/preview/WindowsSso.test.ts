import { assert, describe, it } from "@effect/vitest";
import type { CDPSession } from "playwright-core";

import { makeWindowsSso, withWindowsSsoProof } from "./WindowsSso.ts";

const proof = {
  headers: { "x-ms-RefreshTokenCredential": "account-proof", "x-ms-DeviceCredential": "device" },
  cookies: [],
};

function fakeCdp() {
  const listeners = new Map<string, (event: unknown) => void>();
  const sent: Array<{ method: string; params: unknown }> = [];
  let continued: (params: unknown) => void = () => undefined;
  const cdp = {
    on: (event: string, listener: (event: unknown) => void) => listeners.set(event, listener),
    send: async (method: string, params: unknown) => {
      sent.push({ method, params });
      if (method === "Fetch.continueRequest") continued(params);
    },
  } as unknown as CDPSession;
  const pause = (url: string) =>
    new Promise<{ requestId: string; headers?: Array<{ name: string; value: string }> }>(
      (resolve) => {
        continued = (params) => resolve(params as never);
        listeners.get("Fetch.requestPaused")!({
          requestId: url,
          request: { url, headers: { Accept: "text/html", "X-MS-RefreshTokenCredential": "old" } },
        });
      },
    );
  return { cdp, sent, pause };
}

describe("server browser Windows sign-in", () => {
  it("adds proofs to an Entra navigation, replacing stale ones", async () => {
    const { cdp, sent, pause } = fakeCdp();
    await makeWindowsSso(async () => proof).install(cdp);

    assert.deepStrictEqual(sent[0], {
      method: "Fetch.enable",
      params: {
        patterns: [
          {
            urlPattern: "https://login.microsoftonline.com/*",
            resourceType: "Document",
            requestStage: "Request",
          },
        ],
      },
    });
    const continued = await pause("https://login.microsoftonline.com/common/oauth2/authorize");
    assert.deepStrictEqual(continued.headers, [
      { name: "Accept", value: "text/html" },
      { name: "x-ms-RefreshTokenCredential", value: "account-proof" },
      { name: "x-ms-DeviceCredential", value: "device" },
    ]);
  });

  it("continues other hosts and failed lookups without proofs", async () => {
    const urls: Array<string> = [];
    const { cdp, pause } = fakeCdp();
    await makeWindowsSso(async (url) => {
      urls.push(url);
      throw new Error("no account");
    }).install(cdp);

    // A redirect hop away from Entra is paused separately and must not carry a proof.
    assert.deepStrictEqual(await pause("https://login.microsoftonline.com.example.com/"), {
      requestId: "https://login.microsoftonline.com.example.com/",
    });
    assert.deepStrictEqual(await pause("https://login.microsoftonline.com/common"), {
      requestId: "https://login.microsoftonline.com/common",
    });
    assert.deepStrictEqual(urls, ["https://login.microsoftonline.com/common"]);
  });

  it("leaves requests unchanged when Windows returns no proofs", () => {
    assert.equal(
      withWindowsSsoProof({ Accept: "text/html" }, { headers: {}, cookies: [] }),
      undefined,
    );
  });
});
