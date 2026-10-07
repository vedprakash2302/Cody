// @effect-diagnostics nodeBuiltinImport:off - Windows helper IPC at browser request callback boundaries.
/**
 * Windows work-account sign-in for browser tabs. Cody's Windows helper asks
 * Windows for the device's Entra proofs for one sign-in URL. The Electron
 * browser and the server's headless browser attach them to that navigation.
 */
import * as NodeChildProcess from "node:child_process";

export type WindowsSsoHeaders = Record<string, string>;
export interface WindowsSsoAuth {
  readonly headers: WindowsSsoHeaders;
  readonly cookies: ReadonlyArray<string>;
}

/** Path to the Windows helper, as the WSL backend sees it. Set only while sign-in is enabled. */
export const WINDOWS_SSO_HELPER_ENV = "T3CODE_WINDOWS_SSO_HELPER";

/** Only the public Entra authority is supported. */
export function isWindowsSsoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://login.microsoftonline.com" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** Convert Windows' cookie records without storing device credentials in a cookie jar. */
export function parseWindowsSsoResponse(text: string): WindowsSsoAuth {
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Invalid Windows SSO response");
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    result.ok !== true ||
    !("cookies" in result) ||
    !Array.isArray(result.cookies) ||
    result.cookies.length > 32
  )
    throw new Error("Windows SSO helper failed");

  const headers: WindowsSsoHeaders = {};
  const cookies: string[] = [];
  const names = new Set<string>();
  for (const item of result.cookies) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.name !== "string" ||
      typeof item.data !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(item.name) ||
      /[^\x20-\x7e]/.test(item.data) ||
      names.has(item.name.toLowerCase())
    )
      throw new Error("Invalid Windows SSO response");
    names.add(item.name.toLowerCase());
    // Windows includes Set-Cookie attributes on x-ms-* records. They are
    // request headers here, as in Chromium's CloudApProviderWin.
    const value = item.data.split(";", 1)[0]!;
    if (item.name.toLowerCase().startsWith("x-ms-")) headers[item.name] = value;
    else cookies.push(`${item.name}=${value}`);
  }
  return { headers, cookies };
}

/** Runs the helper for one sign-in URL. Errors never include its output, which carries credentials. */
export function readWindowsSsoAuth(helper: string, url: string): Promise<WindowsSsoAuth> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      helper,
      [],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 128 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Windows SSO helper failed"));
          return;
        }
        try {
          resolve(parseWindowsSsoResponse(stdout));
        } catch {
          reject(new Error("Invalid Windows SSO response"));
        }
      },
    );
    child.stdin?.on("error", () => reject(new Error("Windows SSO helper unavailable")));
    child.stdin?.end(`${url}\n`);
  });
}
