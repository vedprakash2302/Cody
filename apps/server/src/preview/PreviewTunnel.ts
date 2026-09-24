/**
 * Byte tunnel from a client to a loopback port on this environment's host.
 *
 * The desktop Browser panel sends a remote environment's `localhost` traffic
 * here, one WebSocket per TCP connection, so a dev server bound to loopback on
 * this machine loads in a client on another machine with its origin
 * unchanged. The route is same-origin for the reason DeviceHubProxy is: every
 * way a client reaches T3 (LAN, Tailscale, SSH forwards, T3 Connect) already
 * carries `/api/*` WebSocket upgrades.
 *
 * Only loopback is dialed. Access requires terminal scope, which can already
 * reach any local port.
 */
import { AuthTerminalOperateScope } from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type * as Socket from "effect/unstable/socket/Socket";

import { requireUpgradeScope } from "../auth/http.ts";

export const PREVIEW_TUNNEL_ROUTE = "/api/preview-tunnel";

/** Dev servers bind IPv4 or IPv6 loopback depending on the runtime and OS. */
const dialHost = (host: string, port: number) =>
  NodeSocket.makeNet({ host, port, openTimeout: "5 seconds" }).pipe(
    Effect.flatMap((socket) => socket.reader.pipe(Effect.map((reader) => ({ socket, reader })))),
  );

const parsePort = (value: string | null): number | null => {
  if (value === null || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
};

/** The first loopback address accepting connections on `port`, opened for reading. */
const dialLoopback = (port: number) =>
  dialHost("127.0.0.1", port).pipe(Effect.catch(() => dialHost("::1", port)));

const pump = (reader: Socket.Reader, writer: Socket.Writer) =>
  Effect.gen(function* () {
    while (true) {
      yield* writer.writeAll(yield* reader.pull);
    }
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Upgrade Required", { status: 426 });
  }
  const url = HttpServerRequest.toURL(request);
  const port = Option.isSome(url) ? parsePort(url.value.searchParams.get("port")) : null;
  if (port === null) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  yield* requireUpgradeScope(AuthTerminalOperateScope);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Dial before upgrading, so a closed port is a plain HTTP failure the
      // client can report as a refused connection.
      const upstream = yield* dialLoopback(port).pipe(Effect.option);
      if (Option.isNone(upstream)) {
        return HttpServerResponse.text("Bad Gateway", { status: 502 });
      }
      const client = yield* request.upgrade;
      const clientReader = yield* client.reader;
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.value.socket.writer;
      // Whichever side closes first ends the other through scope teardown.
      yield* Effect.raceFirst(
        pump(upstream.value.reader, writeToClient),
        pump(clientReader, writeToUpstream),
      ).pipe(Effect.catchCause(() => Effect.void));
      return HttpServerResponse.empty();
    }),
  );
});

export const previewTunnelRouteLayer = HttpRouter.add("GET", PREVIEW_TUNNEL_ROUTE, handler);

/**
 * Tunnel requests stay out of traces: each one carries a reusable session
 * ticket in its query string, and a page load opens dozens of them.
 */
export const previewTunnelTracerLayer = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
  (request) =>
    request.url === PREVIEW_TUNNEL_ROUTE || request.url.startsWith(`${PREVIEW_TUNNEL_ROUTE}?`),
);
