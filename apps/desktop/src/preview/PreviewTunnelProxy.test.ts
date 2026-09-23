// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - exercises the proxy with real sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isLoopbackHost,
  parseSocksConnect,
  parseSocksGreeting,
  PreviewTunnelProxies,
  SocksReply,
} from "./PreviewTunnelProxy.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const connectRequest = (host: string, port: number) => {
  const name = Buffer.from(host, "latin1");
  const request = Buffer.alloc(7 + name.length);
  request.set([0x05, 0x01, 0x00, 0x03, name.length]);
  name.copy(request, 5);
  request.writeUInt16BE(port, 5 + name.length);
  return request;
};

describe("SOCKS parsing", () => {
  it("accepts only greetings offering no authentication", () => {
    expect(parseSocksGreeting(Buffer.from([0x05]))).toEqual({ _tag: "incomplete" });
    expect(parseSocksGreeting(Buffer.from([0x05, 0x02, 0x02, 0x00]))).toEqual({
      _tag: "parsed",
      value: null,
      consumed: 4,
    });
    expect(parseSocksGreeting(Buffer.from([0x05, 0x01, 0x02]))._tag).toBe("invalid");
    expect(parseSocksGreeting(Buffer.from([0x04, 0x01, 0x00]))._tag).toBe("invalid");
  });

  it("reads CONNECT targets in all three address forms", () => {
    const domain = connectRequest("localhost", 5173);
    expect(parseSocksConnect(domain)).toEqual({
      _tag: "parsed",
      value: { host: "localhost", port: 5173 },
      consumed: domain.length,
    });
    expect(parseSocksConnect(domain.subarray(0, domain.length - 1))).toEqual({
      _tag: "incomplete",
    });
    const ipv4 = Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x14, 0x50]);
    expect(parseSocksConnect(ipv4)).toMatchObject({ value: { host: "127.0.0.1", port: 5200 } });
    const ipv6 = Buffer.alloc(22);
    ipv6.set([0x05, 0x01, 0x00, 0x04]);
    ipv6[19] = 1;
    ipv6.writeUInt16BE(3000, 20);
    expect(parseSocksConnect(ipv6)).toMatchObject({ value: { host: "0:0:0:0:0:0:0:1" } });
    expect(parseSocksConnect(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))).toEqual({
      _tag: "invalid",
      reply: SocksReply.commandNotSupported,
    });
  });

  it("treats the names Chromium resolves to loopback as loopback", () => {
    for (const host of ["localhost", "LOCALHOST.", "app.localhost", "127.0.0.1", "127.9.9.9"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    expect(isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true);
    for (const host of ["example.com", "devbox", "10.0.0.1", "localhost.example.com"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

/**
 * A stand-in for the environment's tunnel route: checks the query, answers
 * a closed port before upgrading like the server does, and upper-cases
 * whatever the tunnel carries.
 */
async function listenFakeTunnel(): Promise<{
  readonly url: string;
  readonly requests: string[];
}> {
  const requests: string[] = [];
  const server = NodeHttp.createServer();
  const upgraded = new Set<NodeNet.Socket>();
  server.on("upgrade", (request, socket: NodeNet.Socket) => {
    upgraded.add(socket);
    const url = new URL(request.url ?? "/", "http://tunnel.test");
    requests.push(`${url.searchParams.get("port")} ${url.searchParams.get("wsTicket")}`);
    if (url.searchParams.get("port") === "1") {
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const accept = NodeCrypto.createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (frame: Buffer) => {
      // Test payloads are short, masked, single frames.
      if ((frame[0]! & 0x0f) !== 0x02) return;
      const length = frame[1]! & 0x7f;
      const mask = frame.subarray(2, 6);
      const payload = Buffer.from(
        frame.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]!),
      );
      const reply = Buffer.from(payload.toString().toUpperCase());
      socket.write(Buffer.concat([Buffer.from([0x82, reply.length]), reply]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        // Upgraded sockets leave the HTTP server's tracking, so end them here.
        for (const socket of upgraded) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as NodeNet.AddressInfo;
  return { url: `ws://127.0.0.1:${port}/api/preview-tunnel`, requests };
}

/** Speaks SOCKS5 to the proxy the way Chromium does, then sends one message. */
function socksRoundTrip(proxyPort: number, host: string, port: number, message: string) {
  return new Promise<{ readonly reply: number; readonly data: string }>((resolve) => {
    const socket = NodeNet.connect(proxyPort, "127.0.0.1");
    let stage = 0;
    let reply = -1;
    socket.on("data", (chunk) => {
      if (stage === 0) {
        stage = 1;
        socket.write(connectRequest(host, port));
      } else if (stage === 1) {
        reply = chunk[1]!;
        stage = 2;
        if (reply === SocksReply.succeeded) socket.write(message);
        else resolve({ reply, data: "" });
      } else {
        resolve({ reply, data: chunk.toString() });
        socket.destroy();
      }
    });
    socket.on("close", () => resolve({ reply, data: "" }));
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

describe("PreviewTunnelProxies", () => {
  const proxies = () => {
    const instance = new PreviewTunnelProxies();
    cleanups.push(() => instance.close());
    return instance;
  };

  it("carries loopback connections through the environment's tunnel with its ticket", async () => {
    const tunnel = await listenFakeTunnel();
    const registry = proxies();
    const port = await registry.portFor("env-remote");
    await registry.setCredentials("env-remote", { tunnelUrl: tunnel.url, wsTicket: "ticket-1" });

    expect(await socksRoundTrip(port, "localhost", 5173, "hello")).toEqual({
      reply: SocksReply.succeeded,
      data: "HELLO",
    });
    expect(tunnel.requests).toEqual(["5173 ticket-1"]);
    // One listener per environment.
    expect(await registry.portFor("env-remote")).toBe(port);
    expect(await registry.portFor("env-other")).not.toBe(port);
  });

  it("holds a connection that arrives before the first ticket", async () => {
    const tunnel = await listenFakeTunnel();
    const registry = proxies();
    const port = await registry.portFor("env-remote");
    const pending = socksRoundTrip(port, "127.0.0.1", 3000, "early");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await registry.setCredentials("env-remote", { tunnelUrl: tunnel.url, wsTicket: "late" });
    expect(await pending).toEqual({ reply: SocksReply.succeeded, data: "EARLY" });
  });

  it("reports a port the environment refuses as a refused connection", async () => {
    const tunnel = await listenFakeTunnel();
    const registry = proxies();
    const port = await registry.portFor("env-remote");
    await registry.setCredentials("env-remote", { tunnelUrl: tunnel.url, wsTicket: "t" });
    expect((await socksRoundTrip(port, "localhost", 1, "x")).reply).toBe(
      SocksReply.connectionRefused,
    );
  });
});
