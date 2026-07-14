import { createServer, type IncomingMessage } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

interface FakeCdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export interface FakeCdpBrowser {
  readonly endpoint: string;
  readonly browserWebSocketUrl: string;
  readonly allowedOrigin: string;
  readonly commands: readonly FakeCdpCommand[];
  close(): Promise<void>;
}

interface FakeOptions {
  readonly malformedDiscovery?: boolean;
  readonly oversizedDiscovery?: boolean;
  readonly invalidBrowserWebSocket?: boolean;
  readonly malformedMessageOnMethod?: string;
  readonly malformedEventOnMethod?: string;
  readonly closeOnMethod?: string;
  readonly hangOnMethod?: string;
  readonly unsupportedMethods?: readonly string[];
  readonly transitionalFrameReads?: number;
  readonly attachedFrameUrl?: string;
  readonly navigateDuringObservationUrl?: string;
  readonly navigateDuringCaptureUrl?: string;
  readonly extraCollections?: boolean;
}

/** Start a real HTTP/WebSocket fake at the same seams as a user-owned browser. */
export const startFakeCdpBrowser = async (
  options: FakeOptions = {},
): Promise<FakeCdpBrowser> => {
  const commands: FakeCdpCommand[] = [];
  const sockets = new Set<WebSocket>();
  let frameTreeReads = 0;
  let port = 0;
  const http = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/version") {
      response.end(
        options.oversizedDiscovery === true
          ? " ".repeat(65 * 1_024)
          : options.malformedDiscovery === true
            ? "{not-json"
            : JSON.stringify({
                Browser: "FakeChrome/1.0",
                "Protocol-Version": "1.3",
                "User-Agent": "FakeChrome",
                "V8-Version": "13.0",
                "WebKit-Version": "fake-revision",
                webSocketDebuggerUrl:
                  options.invalidBrowserWebSocket === true
                    ? `ws://localhost:${String(port)}/devtools/page/not-browser`
                    : `ws://localhost:${String(port)}/devtools/browser/fake`,
              }),
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
    if (request.url !== "/devtools/browser/fake") {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) =>
      webSockets.emit("connection", webSocket, request),
    );
  });
  webSockets.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    void request;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      const command = parseCommand(raw.toString());
      commands.push(command);
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
      if (command.method === "Page.getFrameTree") frameTreeReads += 1;
      socket.send(
        JSON.stringify({
          id: command.id,
          result: resultFor(command, port, options, frameTreeReads),
        }),
      );
      if (options.malformedEventOnMethod === command.method)
        socket.send("{not-json");
      emitEvents(socket, command, port, options);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("Fake CDP server did not bind a TCP address");
  port = address.port;
  const endpoint = `http://127.0.0.1:${String(port)}`;
  return {
    endpoint,
    browserWebSocketUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/fake`,
    allowedOrigin: endpoint,
    commands,
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

const targets = (
  port: number,
  options: FakeOptions = {},
): readonly Record<string, unknown>[] => [
  {
    id: "allowed-page",
    type: "page",
    title: "Inspectable application",
    url: `http://127.0.0.1:${String(port)}/app?token=page-secret#fragment`,
    attached: false,
    webSocketDebuggerUrl: `ws://localhost:${String(port)}/devtools/page/allowed-page`,
  },
  {
    id: "disallowed-page",
    type: "page",
    title: "Must not leak",
    url: "https://private.example.test/app?token=forbidden",
    attached: false,
  },
  {
    id: "unsupported-page",
    type: "page",
    title: "Internal page",
    url: "chrome://settings/",
    attached: false,
  },
  {
    id: "worker-1",
    type: "service_worker",
    title: "Worker",
    url: `http://127.0.0.1:${String(port)}/worker.js?secret=worker`,
    attached: false,
  },
  ...(options.extraCollections === true
    ? [
        {
          id: "worker-2",
          type: "shared_worker",
          title: "Second worker",
          url: `http://127.0.0.1:${String(port)}/worker-2.js`,
          attached: false,
        },
      ]
    : []),
];

const parseCommand = (text: string): FakeCdpCommand => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null)
    throw new TypeError("Expected CDP command object");
  if (!("id" in value) || typeof value.id !== "number")
    throw new TypeError("Expected CDP command id");
  if (!("method" in value) || typeof value.method !== "string")
    throw new TypeError("Expected CDP method");
  const params =
    "params" in value && isRecord(value.params) ? value.params : {};
  return {
    id: value.id,
    method: value.method,
    params,
    ...("sessionId" in value && typeof value.sessionId === "string"
      ? { sessionId: value.sessionId }
      : {}),
  };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resultFor = (
  command: FakeCdpCommand,
  port: number,
  options: FakeOptions,
  frameTreeReads: number,
): Readonly<Record<string, unknown>> => {
  switch (command.method) {
    case "Target.attachToTarget":
      return { sessionId: "session-1" };
    case "Page.getFrameTree":
      return frameTree(
        port,
        frameTreeReads <= (options.transitionalFrameReads ?? 0)
          ? ":"
          : options.attachedFrameUrl,
        options.extraCollections === true,
      );
    case "Page.getResourceTree":
      return resourceTree(port, options.extraCollections === true);
    case "DOMSnapshot.captureSnapshot":
      return domSnapshot(port);
    case "Accessibility.getFullAXTree":
      return accessibilityTree(options.extraCollections === true);
    case "Debugger.getScriptSource":
      return { scriptSource: "export const observed = 'source-secret';" };
    case "Target.getTargets":
      return { targetInfos: targets(port, options).map(endpointTargetToInfo) };
    case "Storage.getUsageAndQuota":
      return { usage: 42, quota: 1_024, usageBreakdown: [] };
    case "DOMStorage.getDOMStorageItems":
      return {
        entries:
          options.extraCollections === true
            ? [
                ["public-key", "storage-secret"],
                ["second-key", "second-secret"],
              ]
            : [["public-key", "storage-secret"]],
      };
    case "IndexedDB.requestDatabaseNames":
      return {
        databaseNames:
          options.extraCollections === true
            ? ["app-db", "second-db"]
            : ["app-db"],
      };
    case "CacheStorage.requestCacheNames":
      return {
        caches: [
          { cacheName: "assets-v1", cacheId: "secret-id" },
          ...(options.extraCollections === true
            ? [{ cacheName: "assets-v2", cacheId: "second-secret-id" }]
            : []),
        ],
      };
    default:
      return {};
  }
};

const endpointTargetToInfo = (
  target: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  targetId: target.id,
  type: target.type,
  title: target.title,
  url: target.url,
  attached: target.attached,
});

const frameTree = (
  port: number,
  overrideUrl?: string,
  extraCollections = false,
): Readonly<Record<string, unknown>> => ({
  frameTree: {
    frame: {
      id: "frame-main",
      loaderId: "loader-main",
      url:
        overrideUrl ??
        `http://127.0.0.1:${String(port)}/app?token=frame-secret`,
    },
    childFrames: [
      ...(extraCollections
        ? [
            {
              frame: {
                id: "frame-child",
                parentId: "frame-main",
                loaderId: "loader-child",
                url: `http://127.0.0.1:${String(port)}/child`,
              },
            },
          ]
        : []),
      {
        frame: {
          id: "frame-private",
          parentId: "frame-main",
          loaderId: "loader-private",
          url: "https://private.example.test/frame?secret=forbidden",
        },
      },
    ],
  },
});

const resourceTree = (
  port: number,
  extraCollections = false,
): Readonly<Record<string, unknown>> => ({
  frameTree: {
    frame: {
      id: "frame-main",
      loaderId: "loader-main",
      url: `http://127.0.0.1:${String(port)}/app`,
    },
    resources: [
      {
        url: `http://127.0.0.1:${String(port)}/app.js?api_key=resource-secret`,
        type: "Script",
        mimeType: "text/javascript",
        contentSize: 128,
      },
      ...(extraCollections
        ? [
            {
              url: `http://127.0.0.1:${String(port)}/app.css`,
              type: "Stylesheet",
              mimeType: "text/css",
              contentSize: 64,
            },
          ]
        : []),
      {
        url: "https://private.example.test/private.js?secret=forbidden",
        type: "Script",
        mimeType: "text/javascript",
      },
    ],
  },
});

const domSnapshot = (port: number): Readonly<Record<string, unknown>> => {
  const strings = [
    `http://127.0.0.1:${String(port)}/app`,
    "#document",
    "",
    "HTML",
    "token",
    "dom-secret",
    "https://private.example.test/frame",
    "PRIVATE-TEXT",
  ];
  return {
    strings,
    documents: [
      {
        documentURL: 0,
        nodes: {
          nodeType: [9, 1],
          nodeName: [1, 3],
          nodeValue: [2, 2],
          parentIndex: [-1, 0],
          attributes: [[], [4, 5]],
        },
      },
      {
        documentURL: 6,
        nodes: {
          nodeType: [3],
          nodeName: [1],
          nodeValue: [7],
          parentIndex: [-1],
          attributes: [[]],
        },
      },
    ],
  };
};

const accessibilityTree = (
  extraCollections = false,
): Readonly<Record<string, unknown>> => ({
  nodes: [
    {
      nodeId: "ax-1",
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "computedString", value: "Submit report" },
      description: { type: "computedString", value: "Sends the form" },
    },
    ...(extraCollections
      ? [
          {
            nodeId: "ax-2",
            parentId: "ax-1",
            ignored: false,
            role: { type: "role", value: "link" },
            name: { type: "computedString", value: "Second action" },
          },
        ]
      : []),
  ],
});

const emitEvents = (
  socket: WebSocket,
  command: FakeCdpCommand,
  port: number,
  options: FakeOptions,
): void => {
  if (command.method === "Debugger.enable") {
    event(socket, "Debugger.scriptParsed", command.sessionId, {
      scriptId: "script-allowed",
      url: `http://127.0.0.1:${String(port)}/app.js?token=script-secret`,
      hash: "cdp-hash",
      length: 40,
      isModule: true,
      scriptLanguage: "JavaScript",
      sourceMapURL: `http://127.0.0.1:${String(port)}/app.js.map?token=map-secret`,
    });
    event(socket, "Debugger.scriptParsed", command.sessionId, {
      scriptId: "script-private",
      url: "https://private.example.test/private.js?secret=forbidden",
      hash: "private-hash",
      length: 100,
      isModule: false,
    });
    event(socket, "Debugger.scriptParsed", command.sessionId, {
      scriptId: "script-inline",
      url: "",
      hash: "inline-secret",
      length: 100,
      isModule: false,
    });
  }
  if (command.method === "Network.enable") {
    if (options.navigateDuringObservationUrl !== undefined)
      event(socket, "Page.frameNavigated", command.sessionId, {
        frame: {
          id: "frame-main",
          url: options.navigateDuringObservationUrl,
        },
      });
    const url = `http://127.0.0.1:${String(port)}/api?token=network-secret`;
    event(socket, "Network.requestWillBeSent", command.sessionId, {
      requestId: "request-1",
      type: "Fetch",
      request: {
        url,
        method: "POST",
        headers: { Authorization: "Bearer request-secret" },
        postData: "request-body-secret",
      },
      initiator: {
        type: "script",
        callFrames: [
          { url: `${url}#caller-secret`, lineNumber: 3, columnNumber: 5 },
        ],
      },
    });
    event(socket, "Network.responseReceived", command.sessionId, {
      requestId: "request-1",
      response: {
        status: 200,
        mimeType: "application/json",
        headers: { "Set-Cookie": "response-secret" },
      },
    });
    event(socket, "Network.loadingFinished", command.sessionId, {
      requestId: "request-1",
      encodedDataLength: 321,
    });
    event(socket, "Network.webSocketCreated", command.sessionId, {
      requestId: "websocket-1",
      url: `ws://127.0.0.1:${String(port)}/live?token=websocket-url-secret`,
    });
    event(socket, "Network.webSocketFrameSent", command.sessionId, {
      requestId: "websocket-1",
      response: { opcode: 1, payloadData: "websocket-secret" },
    });
  }
  if (command.method === "Runtime.enable") {
    event(socket, "Runtime.consoleAPICalled", command.sessionId, {
      type: "log",
      timestamp: 123,
      args: [{ type: "string", value: "console-secret" }],
      stackTrace: {
        callFrames: [
          {
            url: `http://127.0.0.1:${String(port)}/app.js?secret=console-url`,
            lineNumber: 7,
            columnNumber: 9,
          },
        ],
      },
    });
    event(socket, "Runtime.consoleAPICalled", command.sessionId, {
      type: "unknown-origin-console-secret",
      timestamp: 124,
      args: [{ type: "string", value: "unknown-console-value-secret" }],
    });
  }
  if (
    command.method === "DOMSnapshot.captureSnapshot" &&
    options.navigateDuringCaptureUrl !== undefined
  )
    event(socket, "Page.frameNavigated", command.sessionId, {
      frame: {
        id: "frame-main",
        url: options.navigateDuringCaptureUrl,
      },
    });
};

const event = (
  socket: WebSocket,
  method: string,
  sessionId: string | undefined,
  params: Readonly<Record<string, unknown>>,
): void =>
  socket.send(
    JSON.stringify({
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    }),
  );
