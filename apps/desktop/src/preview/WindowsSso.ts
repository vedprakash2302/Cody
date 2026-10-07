// @effect-diagnostics nodeBuiltinImport:off - Windows helper paths at the Electron request callback boundary.
import * as NodePath from "node:path";
import {
  isWindowsSsoUrl,
  readWindowsSsoAuth,
  type WindowsSsoAuth as AuthData,
  type WindowsSsoHeaders as Headers,
} from "@t3tools/shared/windowsSso";
import type { Session, WebRequestFilter } from "electron";

type Request = { id: number; url: string; resourceType: string; requestHeaders: Headers };

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
  const handler = createWindowsSsoHandler((url) => readWindowsSsoAuth(helper, url), enabled);
  // Match navigations in Chromium, avoiding blocking interception of assets.
  // Keep all URLs so redirects away from Entra still remove attached proofs.
  const filter: WebRequestFilter = { urls: ["<all_urls>"], types: ["mainFrame", "subFrame"] };
  browserSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    void handler.handle(details).then((requestHeaders) => callback({ requestHeaders }));
  });
  browserSession.webRequest.onCompleted(filter, (details) => handler.finish(details.id));
  browserSession.webRequest.onErrorOccurred(filter, (details) => handler.finish(details.id));
}
