import { createServer } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

/**
 * Expose Chrome discovery through a page-scoped-only CDP endpoint.
 *
 * The proxy deliberately reports a `/devtools/page/<id>` socket from
 * `/json/version`, so the verifier cannot silently fall back to the browser
 * socket. WebSocket bytes are forwarded without interpreting CDP messages.
 */
export async function startPageCdpProxy(upstreamEndpoint) {
  const clients = new Set();
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== "/json/version" && request.url !== "/json/list") {
        response.writeHead(404).end();
        return;
      }
      const value = await upstreamJson(upstreamEndpoint, request.url);
      const pageScoped =
        request.url === "/json/version"
          ? await pageScopedVersion(upstreamEndpoint, value)
          : value;
      const rewritten = rewriteWebSocketEndpoints(pageScoped, server);
      const body = JSON.stringify(rewritten);
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(body);
    } catch (error) {
      response.writeHead(502).end(String(error));
    }
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/devtools/page/")) {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(
        new URL(request.url, upstreamEndpoint).href.replace(/^http/, "ws"),
      );
      const pending = [];
      clients.add(client);
      const close = () => {
        clients.delete(client);
        if (client.readyState < WebSocket.CLOSING) client.close();
        if (upstream.readyState < WebSocket.CLOSING) upstream.close();
      };
      client.on("message", (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN)
          upstream.send(data, { binary });
        else pending.push({ data, binary });
      });
      upstream.on("message", (data, binary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      });
      upstream.on("open", () => {
        for (const { data, binary } of pending) upstream.send(data, { binary });
        pending.length = 0;
        webSockets.emit("connection", client, request);
      });
      client.on("close", close);
      client.on("error", close);
      upstream.on("close", close);
      upstream.on("error", close);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Page CDP proxy did not bind a TCP port");
  const endpoint = `http://127.0.0.1:${String(address.port)}`;
  return {
    endpoint,
    disconnectClients() {
      for (const client of clients) client.terminate();
    },
    async close() {
      for (const client of clients) client.terminate();
      webSockets.close();
      await new Promise((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    },
  };
}

async function pageScopedVersion(upstreamEndpoint, version) {
  const targets = await upstreamJson(upstreamEndpoint, "/json/list");
  const page = targets.find(
    (target) =>
      target.type === "page" && typeof target.webSocketDebuggerUrl === "string",
  );
  if (page === undefined) throw new Error("Chrome exposed no page CDP socket");
  return { ...version, webSocketDebuggerUrl: page.webSocketDebuggerUrl };
}

function rewriteWebSocketEndpoints(value, server) {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Page CDP proxy has no TCP address");
  const rewrite = (entry) => {
    if (typeof entry.webSocketDebuggerUrl !== "string") return entry;
    const url = new URL(entry.webSocketDebuggerUrl);
    url.hostname = "127.0.0.1";
    url.port = String(address.port);
    return { ...entry, webSocketDebuggerUrl: url.href };
  };
  return Array.isArray(value) ? value.map(rewrite) : rewrite(value);
}

async function upstreamJson(endpoint, path) {
  const response = await fetch(new URL(path, endpoint));
  if (!response.ok)
    throw new Error(`Upstream CDP ${path} returned ${response.status}`);
  return await response.json();
}
