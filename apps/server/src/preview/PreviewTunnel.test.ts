// @effect-diagnostics nodeBuiltinImport:off - the upstream is a real loopback TCP server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import type * as NetAddress from "effect/unstable/net/NetAddress";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { previewTunnelRouteLayer } from "./PreviewTunnel.ts";

const serveTunnel = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.gen(function* () {
    yield* HttpRouter.serve(previewTunnelRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.succeed(EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token",
              scopes,
            }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.build,
    );
    const server = yield* HttpServer.HttpServer;
    return (server.address as NetAddress.InetAddress).port;
  });

const UPGRADE_HEADERS = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-version": "13",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
};

/** A loopback TCP server that answers each line with its upper-cased echo. */
const listenUpper = (host: string) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeNet.Server>((resolve) => {
          const server = NodeNet.createServer((socket) => {
            socket.on("data", (data) => socket.write(data.toString().toUpperCase()));
          });
          server.listen(0, host, () => resolve(server));
        }),
    ),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  ).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

/** Opens the tunnel, sends `message`, and resolves with the first reply or the failure. */
const roundTrip = (url: string, message: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => socket.send(new TextEncoder().encode(message)));
        socket.addEventListener("message", (event) => {
          resolve(new TextDecoder().decode(event.data as ArrayBuffer));
          socket.close();
        });
        socket.addEventListener("error", () => resolve("error"));
      }),
  );

it.effect("pipes bytes to a loopback port over IPv4 and IPv6", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tunnelPort = yield* serveTunnel([AuthTerminalOperateScope]);
      for (const host of ["127.0.0.1", "::1"]) {
        const upstreamPort = yield* listenUpper(host);
        const reply = yield* roundTrip(
          `ws://127.0.0.1:${tunnelPort}/api/preview-tunnel?port=${upstreamPort}`,
          `hello ${host}`,
        );
        expect(reply).toBe(`HELLO ${host.toUpperCase()}`);
      }
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses closed ports, bad ports, and plain requests", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tunnelPort = yield* serveTunnel([AuthTerminalOperateScope]);
      const base = `http://127.0.0.1:${tunnelPort}/api/preview-tunnel`;
      const upgrade = (query: string, headers: NodeHttp.OutgoingHttpHeaders = UPGRADE_HEADERS) =>
        Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const request = NodeHttp.request(`${base}${query}`, { headers, agent: false });
              request.on("response", (response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
              });
              request.on("upgrade", (_response, socket) => {
                socket.destroy();
                resolve(101);
              });
              request.on("error", () => resolve(-1));
              request.end();
            }),
        );
      // Port 1 is privileged and unused, so nothing accepts on it.
      expect(yield* upgrade("?port=1")).toBe(502);
      expect(yield* upgrade("?port=70000")).toBe(400);
      expect(yield* upgrade("?port=80;rm")).toBe(400);
      expect(yield* upgrade("?port=80", {})).toBe(426);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("requires terminal scope, which can already reach any local port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const operatorPort = yield* serveTunnel([AuthOrchestrationOperateScope]);
      const upstreamPort = yield* listenUpper("127.0.0.1");
      expect(
        yield* roundTrip(
          `ws://127.0.0.1:${operatorPort}/api/preview-tunnel?port=${upstreamPort}`,
          "x",
        ),
      ).toBe("error");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
