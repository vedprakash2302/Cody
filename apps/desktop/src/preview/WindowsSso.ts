// @effect-diagnostics nodeBuiltinImport:off - Windows helper IPC at the Electron request callback boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import type { Session, WebRequestFilter } from "electron";

type Headers = Record<string, string>;
type AuthData = { headers: Headers; cookies: string[] };
type Request = { id: number; url: string; resourceType: string; requestHeaders: Headers };

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
export function parseWindowsSsoResponse(text: string): AuthData {
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

  const headers: Headers = {};
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

function readWindowsAuth(helper: string, url: string): Promise<AuthData> {
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
        // Do not propagate execFile's error: it can contain credential stdout.
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

/** Track auth per network request so a cross-origin redirect cannot carry it along. */
export function createWindowsSsoHandler(
  getAuth: (url: string) => Promise<AuthData>,
  enabled: () => Promise<boolean> = async () => true,
) {
  const applied = new Map<number, AuthData>();
  const pending = new Map<number, object>();
  let active = 0;
  const finish = (id: number) => {
    applied.delete(id);
    pending.delete(id);
  };
  const handle = async (request: Request): Promise<Headers> => {
    const headers = { ...request.requestHeaders };
    const previous = applied.get(request.id);
    applied.delete(request.id);
    if (previous) {
      for (const key of Object.keys(headers)) {
        if (
          Object.keys(previous.headers).some(
            (name) =>
              name.toLowerCase() === key.toLowerCase() && previous.headers[name] === headers[key],
          )
        )
          delete headers[key];
        if (key.toLowerCase() === "cookie") {
          const remaining = headers[key]!.split(";")
            .map((part) => part.trim())
            .filter((part) => !previous.cookies.includes(part));
          if (remaining.length) headers[key] = remaining.join("; ");
          else delete headers[key];
        }
      }
    }
    if (
      !isWindowsSsoUrl(request.url) ||
      (request.resourceType !== "mainFrame" && request.resourceType !== "subFrame") ||
      active >= 4
    )
      return headers;

    active++;
    const operation = {};
    pending.set(request.id, operation);
    try {
      if (!(await enabled()) || pending.get(request.id) !== operation) return headers;
      const auth = await getAuth(request.url);
      if (!(await enabled()) || pending.get(request.id) !== operation) return headers;
      for (const [name, value] of Object.entries(auth.headers)) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
        }
        headers[name] = value;
      }
      if (auth.cookies.length) {
        const key =
          Object.keys(headers).find((name) => name.toLowerCase() === "cookie") ?? "Cookie";
        headers[key] = [headers[key], ...auth.cookies].filter(Boolean).join("; ");
      }
      applied.set(request.id, auth);
    } catch {
      // No Windows account, timeout, or unsupported host: normal interactive sign-in.
    } finally {
      active--;
      if (pending.get(request.id) === operation) pending.delete(request.id);
    }
    return headers;
  };
  return { handle, finish };
}

/** Incognito never uses the Windows account. Existing sessions read the current setting. */
export function installWindowsSso(
  browserSession: Session,
  persistent: boolean,
  platform: NodeJS.Platform,
  helper: string | undefined,
  enabled: () => Promise<boolean> = async () => false,
): void {
  if (platform !== "win32" || !persistent || !helper || !NodePath.win32.isAbsolute(helper)) return;
  const handler = createWindowsSsoHandler((url) => readWindowsAuth(helper, url), enabled);
  // Match navigations in Chromium, avoiding blocking interception of assets.
  // Keep all URLs so redirects away from Entra still remove attached proofs.
  const filter: WebRequestFilter = { urls: ["<all_urls>"], types: ["mainFrame", "subFrame"] };
  browserSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    void handler.handle(details).then((requestHeaders) => callback({ requestHeaders }));
  });
  browserSession.webRequest.onCompleted(filter, (details) => handler.finish(details.id));
  browserSession.webRequest.onErrorOccurred(filter, (details) => handler.finish(details.id));
}
