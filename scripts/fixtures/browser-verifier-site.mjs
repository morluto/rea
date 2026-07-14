import { createServer } from "node:http";

import { WebSocketServer } from "ws";

/** Start the local HTTP/WS application used by real-browser verification. */
export async function startBrowserVerifierSite() {
  let port = 0;
  let sessionGeneration = 0;
  const server = createServer((request, response) => {
    if (request.url === "/app.js.map") {
      response.setHeader("content-type", "application/source-map+json");
      response.end(sourceMap());
      return;
    }
    if (request.url === "/session-generation") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ generation: sessionGeneration }));
      return;
    }
    if (request.url?.startsWith("/app.js") === true) {
      response.setHeader("content-type", "text/javascript");
      response.end(browserScript(port));
      return;
    }
    if (request.url?.startsWith("/api") === true) {
      response.setHeader("content-type", "application/json");
      response.setHeader(
        "content-security-policy",
        "default-src 'self'; connect-src 'self' ws:",
      );
      response.setHeader(
        "link",
        '</.well-known/mcp.json>; rel="service-desc"; type="application/json"',
      );
      response.setHeader("permissions-policy", "geolocation=(), camera=()");
      response.end('{"ok":true,"secret":"response-secret-value"}');
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><html><head><title>REA browser verifier</title></head><body><main><h1>Browser evidence</h1><button aria-label="ax-private-label-value">Verify</button></main><script type="module" src="/app.js?token=script-query-secret"></script></body></html>',
    );
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.on("message", () =>
        webSocket.send("websocket-response-secret"),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Local browser verifier did not bind a TCP port");
  port = address.port;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    triggerSessionNavigation() {
      sessionGeneration += 1;
    },
    async close() {
      for (const client of webSockets.clients) client.terminate();
      await new Promise((resolve) => webSockets.close(resolve));
      await new Promise((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    },
  };
}

const browserScript = (port) => `
  export const reaSourceMarker = "approved-source-marker";
  export const verifiedRoute = { path: "/verified-route" };
  localStorage.setItem("rea-storage-key", "storage-secret-value");
  indexedDB.open("rea-browser-db", 1);
  caches.open("rea-browser-cache");
  const observe = () => {
    console.log("rea-browser-observation", "authorization=Bearer console-secret-value");
    fetch("/api?token=network-secret-value", {
      method: "POST",
      headers: {
        Authorization: "Bearer request-secret-value",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token: "request-body-secret-value", active: true })
    });
    const socket = new WebSocket("ws://127.0.0.1:${String(port)}/live?token=websocket-url-secret");
    socket.addEventListener("open", () => socket.send(JSON.stringify({ token: "websocket-secret-value" })));
    socket.addEventListener("message", () => socket.close());
  };
  observe();
  setInterval(observe, 150);
  let observedGeneration = 0;
  setInterval(async () => {
    const response = await fetch("/session-generation");
    const { generation } = await response.json();
    if (generation <= observedGeneration) return;
    observedGeneration = generation;
    history.pushState({}, "", "/app/session-" + String(generation));
  }, 100);
  //# sourceMappingURL=/app.js.map
`;

const sourceMap = () =>
  JSON.stringify({
    version: 3,
    file: "app.js",
    names: ["reaSourceMarker"],
    sources: ["../src/main.ts"],
    sourcesContent: [
      "import './dependency.ts';\nexport const reaSourceMarker = 'approved-source-marker';",
    ],
    mappings: "AAAAA",
  });
