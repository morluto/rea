import { createServer, type IncomingMessage } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { emitEvents } from "./fakeCdpBrowserEvents.js";
import { resultFor, versionTargetId } from "./fakeCdpBrowserResults.js";
import { parseCommand, targets } from "./fakeCdpBrowserTargets.js";
import type {
  FakeCdpBrowser,
  FakeCdpCommand,
  FakeOptions,
} from "./fakeCdpBrowserTypes.js";

export type { FakeCdpBrowser, FakeOptions } from "./fakeCdpBrowserTypes.js";
/** Start a real HTTP/WebSocket fake at the same seams as a user-owned browser. */
export const startFakeCdpBrowser = async (
  options: FakeOptions = {},
): Promise<FakeCdpBrowser> => {
  const commands: FakeCdpCommand[] = [];
  const httpRequests: {
    url: string;
    authorization: string | undefined;
    cookie: string | undefined;
    referer: string | undefined;
  }[] = [];
  const sockets = new Set<WebSocket>();
  let frameTreeReads = 0;
  let port = 0;
  const http = createServer((request, response) => {
    httpRequests.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      referer: request.headers.referer,
    });
    response.setHeader("content-type", "application/json");
    if (
      request.url?.startsWith("/app.js.map") === true &&
      options.sourceMapBody !== undefined
    ) {
      response.end(options.sourceMapBody);
      return;
    }
    if (request.url === "/json/version") {
      const version = JSON.stringify({
        Browser: "FakeChrome/1.0",
        "Protocol-Version": "1.3",
        "User-Agent": "FakeChrome",
        "V8-Version": "13.0",
        "WebKit-Version": "fake-revision",
        webSocketDebuggerUrl:
          options.invalidBrowserWebSocket === true
            ? `ws://localhost:${String(port)}/devtools/invalid/fake`
            : options.pageScopedVersionWebSocket === true
              ? `ws://localhost:${String(port)}/devtools/page/${versionTargetId(options)}`
              : `ws://localhost:${String(port)}/devtools/browser/fake`,
      });
      response.end(
        options.oversizedDiscovery === true
          ? `${" ".repeat(1_024 * 1_024 + 1)}${version}`
          : options.malformedDiscovery === true
            ? "{not-json"
            : version,
      );
      return;
    }
    if (request.url === "/json/list") {
      response.end(JSON.stringify(targets(port, options)));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  const webSockets = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/devtools/browser/fake" &&
      request.url !== "/devtools/page/allowed-page" &&
      request.url !== "/devtools/page/allowed-page-with-socket" &&
      request.url !== "/devtools/page/electron-page"
    ) {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) =>
      webSockets.emit("connection", webSocket, request),
    );
  });
  webSockets.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const directPage = request.url?.startsWith("/devtools/page/") === true;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const command = parseCommand(raw.toString());
      commands.push(command);
      const commandError = options.commandError?.(command);
      if (commandError !== undefined) {
        socket.send(JSON.stringify({ id: command.id, error: commandError }));
        return;
      }
      if (options.closeOnMethod === command.method) {
        socket.close();
        return;
      }
      if (options.hangOnMethod === command.method) return;
      if (options.malformedMessageOnMethod === command.method) {
        socket.send("{not-json");
        return;
      }
      if (options.unsupportedMethods?.includes(command.method) === true) {
        socket.send(
          JSON.stringify({
            id: command.id,
            error: { code: -32_601, message: "Method not found" },
          }),
        );
        return;
      }
      if (
        directPage &&
        (command.method === "Target.attachToTarget" ||
          command.sessionId !== undefined)
      ) {
        socket.send(
          JSON.stringify({
            id: command.id,
            error: { code: -32_600, message: "Direct page socket expected" },
          }),
        );
        return;
      }
      if (command.method === "Page.getFrameTree") frameTreeReads += 1;
      replyToCommand(socket, command, port, options, frameTreeReads);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  port = boundPort(http.address());
  const endpoint = `http://127.0.0.1:${String(port)}`;
  return {
    endpoint,
    browserWebSocketUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/fake`,
    allowedOrigin: endpoint,
    commands,
    emitRawMessage(message) {
      for (const socket of sockets) socket.send(message);
    },
    emitEvent(event) {
      for (const socket of sockets) socket.send(JSON.stringify(event));
    },
    httpRequests,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        http.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    },
  };
};

const boundPort = (
  address: string | null | { readonly port: number },
): number => {
  if (address === null || typeof address === "string")
    throw new Error("Fake CDP server did not bind a TCP address");
  return address.port;
};

/** Emit a configured producer reply and its associated events. */
const replyToCommand = (
  socket: WebSocket,
  command: FakeCdpCommand,
  port: number,
  options: FakeOptions,
  frameTreeReads: number,
): void => {
  const result =
    options.commandResult?.(
      command,
      `http://127.0.0.1:${String(port)}`,
      frameTreeReads,
    ) ?? resultFor(command, port, options, frameTreeReads);
  if (result === undefined) {
    socket.send(
      JSON.stringify({
        id: command.id,
        error: {
          code: -32_601,
          message: `Method not found: ${command.method}`,
        },
      }),
    );
    return;
  }
  socket.send(
    JSON.stringify({
      id: command.id,
      result,
    }),
  );
  if (options.malformedEventOnMethod === command.method)
    socket.send("{not-json");
  if (options.malformedEventShapeOnMethod === command.method)
    socket.send(JSON.stringify({ method: 42 }));
  const customEvents = options.commandEvents?.(
    command,
    `http://127.0.0.1:${String(port)}`,
  );
  if (customEvents === undefined) emitEvents(socket, command, port, options);
  else for (const event of customEvents) socket.send(JSON.stringify(event));
  if (options.closeAfterMethod === command.method)
    setImmediate(() => socket.close());
};
