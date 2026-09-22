import * as NodeHttp from "node:http";

// Windows hosts with a different TLS setup can use WSL's registry connection.
// Only GET/HEAD requests to the fixed public npm registry are accepted.
export async function startRegistry() {
  const server = NodeHttp.createServer(async (request, response) => {
    if (
      !["GET", "HEAD"].includes(request.method) ||
      !request.url?.startsWith("/") ||
      request.url.startsWith("//")
    ) {
      response.writeHead(405).end();
      return;
    }
    try {
      const upstream = await fetch(`https://registry.npmjs.org${request.url}`, {
        method: request.method,
      });
      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      response.writeHead(upstream.status, { "content-type": contentType });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      if (contentType.includes("json")) {
        const address = server.address();
        response.end(
          (await upstream.text()).replaceAll(
            "https://registry.npmjs.org",
            `http://127.0.0.1:${address.port}`,
          ),
        );
      } else {
        for await (const chunk of upstream.body) response.write(chunk);
        response.end();
      }
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
