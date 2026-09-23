// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a raw SOCKS5 listener driven by socket callbacks, outside any Effect fiber.
/**
 * Routes a remote environment's `localhost` preview traffic to that
 * environment's machine.
 *
 * Each preview session for a remote environment gets this SOCKS5 proxy
 * (`fixed_servers` with the `<-loopback>` bypass rule, so Chromium stops
 * skipping the proxy for loopback). A loopback CONNECT becomes one WebSocket
 * to the environment's `/api/preview-tunnel`, which dials the same port on
 * its own loopback. The page keeps its `localhost` origin, so dev servers,
 * HMR sockets, cookies, and secure-context APIs behave as they do locally.
 * Every other host is dialed directly, as it would be without a proxy.
 *
 * Chromium's PAC mode always bypasses loopback, which is why the rules are
 * fixed and the proxy handles non-loopback hosts itself.
 *
 * The listener binds 127.0.0.1 on a random port. Chromium's SOCKS client
 * cannot authenticate, so another local process that finds the port could
 * reach the environment's loopback with this user's credentials.
 */
import * as NodeNet from "node:net";

export interface PreviewTunnelCredentials {
  /** `ws(s)://…/api/preview-tunnel` on the environment. */
  readonly tunnelUrl: string;
  /** A short-lived `wsTicket`; the renderer replaces it before it expires. */
  readonly wsTicket: string;
}

export interface SocksConnectRequest {
  readonly host: string;
  readonly port: number;
}

/** SOCKS5 reply codes (RFC 1928 §6). */
export const SocksReply = {
  succeeded: 0x00,
  generalFailure: 0x01,
  hostUnreachable: 0x04,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08,
} as const;

type ParseResult<A> =
  | { readonly _tag: "incomplete" }
  | { readonly _tag: "invalid"; readonly reply: number }
  | { readonly _tag: "parsed"; readonly value: A; readonly consumed: number };

const INCOMPLETE = { _tag: "incomplete" } as const;

/** The client's method list. Only "no authentication" is offered back. */
export function parseSocksGreeting(buffer: Buffer): ParseResult<null> {
  if (buffer.length < 2) return INCOMPLETE;
  if (buffer[0] !== 0x05) return { _tag: "invalid", reply: SocksReply.generalFailure };
  const consumed = 2 + buffer[1]!;
  if (buffer.length < consumed) return INCOMPLETE;
  return buffer.subarray(2, consumed).includes(0x00)
    ? { _tag: "parsed", value: null, consumed }
    : { _tag: "invalid", reply: SocksReply.generalFailure };
}

export function parseSocksConnect(buffer: Buffer): ParseResult<SocksConnectRequest> {
  if (buffer.length < 5) return INCOMPLETE;
  if (buffer[0] !== 0x05) return { _tag: "invalid", reply: SocksReply.generalFailure };
  if (buffer[1] !== 0x01) return { _tag: "invalid", reply: SocksReply.commandNotSupported };
  let host: string;
  let offset: number;
  switch (buffer[3]) {
    case 0x01:
      offset = 8;
      if (buffer.length < offset + 2) return INCOMPLETE;
      host = [...buffer.subarray(4, 8)].join(".");
      break;
    case 0x03:
      offset = 5 + buffer[4]!;
      if (buffer.length < offset + 2) return INCOMPLETE;
      host = buffer.subarray(5, offset).toString("latin1");
      break;
    case 0x04: {
      offset = 20;
      if (buffer.length < offset + 2) return INCOMPLETE;
      const groups: string[] = [];
      for (let index = 4; index < 20; index += 2) {
        groups.push(buffer.readUInt16BE(index).toString(16));
      }
      host = groups.join(":");
      break;
    }
    default:
      return { _tag: "invalid", reply: SocksReply.addressTypeNotSupported };
  }
  return {
    _tag: "parsed",
    value: { host, port: buffer.readUInt16BE(offset) },
    consumed: offset + 2,
  };
}

export function socksReply(code: number): Buffer {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

/** The names Chromium itself treats as loopback, in the forms SOCKS delivers them. */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    /^127(\.\d{1,3}){3}$/.test(name) ||
    name === "::1" ||
    name === "0:0:0:0:0:0:0:1"
  );
}

/** Stop reading the page's socket while this much is queued for the tunnel. */
const TUNNEL_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const TUNNEL_DRAIN_POLL_MS = 10;
/** A tab can load before the renderer's first ticket lands. */
const CREDENTIALS_WAIT_MS = 10_000;

interface EnvironmentProxy {
  readonly server: NodeNet.Server;
  readonly port: number;
  readonly connections: Set<NodeNet.Socket>;
  credentials: PreviewTunnelCredentials | null;
  readonly waiters: Set<(credentials: PreviewTunnelCredentials) => void>;
}

const replyForSocketError = (error: NodeJS.ErrnoException) =>
  error.code === "ECONNREFUSED"
    ? SocksReply.connectionRefused
    : error.code === "ENOTFOUND" || error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH"
      ? SocksReply.hostUnreachable
      : SocksReply.generalFailure;

function connectDirect(client: NodeNet.Socket, request: SocksConnectRequest, head: Buffer) {
  const upstream = NodeNet.connect({ host: request.host, port: request.port });
  upstream.once("connect", () => {
    client.write(socksReply(SocksReply.succeeded));
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.once("error", (error) => {
    if (upstream.connecting) client.end(socksReply(replyForSocketError(error)));
    else client.destroy();
  });
  client.once("close", () => upstream.destroy());
}

function connectTunnel(
  client: NodeNet.Socket,
  port: number,
  credentials: PreviewTunnelCredentials,
  head: Buffer,
) {
  const url = new URL(credentials.tunnelUrl);
  url.searchParams.set("port", String(port));
  url.searchParams.set("wsTicket", credentials.wsTicket);
  const tunnel = new WebSocket(url);
  tunnel.binaryType = "arraybuffer";
  let open = false;

  const resumeWhenDrained = () => {
    if (tunnel.readyState !== WebSocket.OPEN) return;
    if (tunnel.bufferedAmount > TUNNEL_HIGH_WATER_BYTES) {
      setTimeout(resumeWhenDrained, TUNNEL_DRAIN_POLL_MS);
    } else {
      client.resume();
    }
  };
  const send = (chunk: Buffer) => {
    tunnel.send(new Uint8Array(chunk));
    if (tunnel.bufferedAmount > TUNNEL_HIGH_WATER_BYTES) {
      client.pause();
      setTimeout(resumeWhenDrained, TUNNEL_DRAIN_POLL_MS);
    }
  };

  tunnel.addEventListener("open", () => {
    open = true;
    client.write(socksReply(SocksReply.succeeded));
    if (head.length > 0) send(head);
    client.on("data", send);
    client.resume();
  });
  tunnel.addEventListener("message", (event) => {
    client.write(Buffer.from(event.data as ArrayBuffer));
  });
  // The server answers a closed port before upgrading, which surfaces here as
  // a failed handshake rather than a close.
  tunnel.addEventListener("error", () => {
    if (!open) client.end(socksReply(SocksReply.connectionRefused));
  });
  tunnel.addEventListener("close", () => {
    if (open) client.end();
  });
  client.once("close", () => {
    if (tunnel.readyState === WebSocket.CONNECTING || tunnel.readyState === WebSocket.OPEN) {
      tunnel.close();
    }
  });
}

/** One SOCKS5 listener per remote environment, alive for the app's lifetime. */
export class PreviewTunnelProxies {
  private readonly proxies = new Map<string, Promise<EnvironmentProxy>>();

  /** The loopback port of the environment's proxy, started on first use. */
  async portFor(environmentId: string): Promise<number> {
    return (await this.proxyFor(environmentId)).port;
  }

  async setCredentials(
    environmentId: string,
    credentials: PreviewTunnelCredentials | null,
  ): Promise<void> {
    const proxy = await this.proxyFor(environmentId);
    proxy.credentials = credentials;
    if (credentials === null) return;
    for (const resolve of proxy.waiters) resolve(credentials);
    proxy.waiters.clear();
  }

  async close(): Promise<void> {
    const proxies = await Promise.all(this.proxies.values());
    this.proxies.clear();
    await Promise.all(
      proxies.map(
        (proxy) =>
          new Promise<void>((resolve) => {
            // `close` waits for open sockets, so end them first.
            for (const connection of proxy.connections) connection.destroy();
            proxy.server.close(() => resolve());
          }),
      ),
    );
  }

  private proxyFor(environmentId: string): Promise<EnvironmentProxy> {
    let proxy = this.proxies.get(environmentId);
    if (proxy === undefined) {
      proxy = this.listen();
      // A failed listen must not be cached; the next tab retries.
      proxy.catch(() => this.proxies.delete(environmentId));
      this.proxies.set(environmentId, proxy);
    }
    return proxy;
  }

  private listen(): Promise<EnvironmentProxy> {
    return new Promise((resolve, reject) => {
      const connections = new Set<NodeNet.Socket>();
      let proxy: EnvironmentProxy | undefined;
      const server = NodeNet.createServer((client) => {
        connections.add(client);
        client.once("close", () => connections.delete(client));
        client.on("error", () => client.destroy());
        if (proxy === undefined) client.destroy();
        else this.accept(proxy, client);
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as NodeNet.AddressInfo;
        proxy = { server, port: address.port, connections, credentials: null, waiters: new Set() };
        resolve(proxy);
      });
    });
  }

  private accept(proxy: EnvironmentProxy, client: NodeNet.Socket) {
    let buffer = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!greeted) {
        const greeting = parseSocksGreeting(buffer);
        if (greeting._tag === "incomplete") return;
        if (greeting._tag === "invalid") {
          client.end(Buffer.from([0x05, 0xff]));
          return;
        }
        greeted = true;
        buffer = buffer.subarray(greeting.consumed);
        client.write(Buffer.from([0x05, 0x00]));
      }
      const request = parseSocksConnect(buffer);
      if (request._tag === "incomplete") return;
      client.off("data", onData);
      if (request._tag === "invalid") {
        client.end(socksReply(request.reply));
        return;
      }
      // Hold the page's bytes until the far side is connected.
      client.pause();
      const head = buffer.subarray(request.consumed);
      if (!isLoopbackHost(request.value.host)) {
        connectDirect(client, request.value, head);
        return;
      }
      void this.credentialsFor(proxy).then((credentials) => {
        if (client.destroyed) return;
        if (credentials === null) client.end(socksReply(SocksReply.generalFailure));
        else connectTunnel(client, request.value.port, credentials, head);
      });
    };
    client.on("data", onData);
  }

  private credentialsFor(proxy: EnvironmentProxy): Promise<PreviewTunnelCredentials | null> {
    if (proxy.credentials !== null) return Promise.resolve(proxy.credentials);
    return new Promise((resolve) => {
      const waiter = (credentials: PreviewTunnelCredentials) => {
        clearTimeout(timer);
        resolve(credentials);
      };
      const timer = setTimeout(() => {
        proxy.waiters.delete(waiter);
        resolve(null);
      }, CREDENTIALS_WAIT_MS);
      proxy.waiters.add(waiter);
    });
  }
}
