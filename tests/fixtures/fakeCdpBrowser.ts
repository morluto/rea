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
  readonly httpRequests: readonly {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly cookie: string | undefined;
    readonly referer: string | undefined;
  }[];
  close(): Promise<void>;
}

interface FakeOptions {
  readonly malformedDiscovery?: boolean;
  readonly oversizedDiscovery?: boolean;
  readonly invalidBrowserWebSocket?: boolean;
  readonly malformedMessageOnMethod?: string;
  readonly malformedEventOnMethod?: string;
  readonly malformedEventShapeOnMethod?: string;
  readonly closeOnMethod?: string;
  readonly hangOnMethod?: string;
  readonly unsupportedMethods?: readonly string[];
  readonly transitionalFrameReads?: number;
  readonly attachedFrameUrl?: string;
  readonly frameUrlAfterFirstRead?: string;
  readonly navigateDuringObservationUrl?: string;
  readonly navigateDuringCaptureUrl?: string;
  readonly navigateDuringScreenshotUrl?: string;
  readonly extraCollections?: boolean;
  readonly foreignSessionEvents?: boolean;
  readonly redirectToDisallowedOrigin?: boolean;
  readonly unrelatedWorker?: boolean;
  readonly binaryWebSocketEvent?: boolean;
  readonly invalidBinaryWebSocketEvent?: boolean;
  readonly sourceMapBody?: string;
  readonly sessionTimeline?: "same_origin" | "outside_policy";
  readonly sensitiveShapes?: boolean;
  readonly invalidResponseBodyBase64?: boolean;
  readonly webMcpTools?: boolean;
  readonly webMcpChildLeavesScope?: boolean;
  readonly electronFileUrl?: string;
  readonly duplicateElectronInventory?: boolean;
}

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
      if (options.malformedEventShapeOnMethod === command.method)
        socket.send(JSON.stringify({ method: 42 }));
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
    openerId: "allowed-page",
  },
  ...(options.extraCollections === true
    ? [
        {
          id: "worker-2",
          type: "shared_worker",
          title: "Second worker",
          url: `http://127.0.0.1:${String(port)}/worker-2.js`,
          attached: false,
          openerId: "allowed-page",
        },
      ]
    : []),
  ...(options.unrelatedWorker === true
    ? [
        {
          id: "worker-other-page",
          type: "dedicated_worker",
          title: "Other page worker",
          url: `http://127.0.0.1:${String(port)}/other-page-worker.js`,
          attached: false,
          openerId: "other-page",
        },
      ]
    : []),
  ...(options.electronFileUrl === undefined
    ? []
    : [
        {
          id: "electron-page",
          type: "page",
          title: "Electron application",
          url: options.electronFileUrl,
          attached: false,
        },
      ]),
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
        frameTreeReads > 1 && options.frameUrlAfterFirstRead !== undefined
          ? options.frameUrlAfterFirstRead
          : frameTreeReads <= (options.transitionalFrameReads ?? 0)
            ? ":"
            : (options.electronFileUrl ?? options.attachedFrameUrl),
        options.extraCollections === true,
      );
    case "Page.getResourceTree":
      return resourceTree(
        port,
        options.extraCollections === true,
        options.electronFileUrl,
        options.duplicateElectronInventory === true,
      );
    case "DOMSnapshot.captureSnapshot":
      return domSnapshot(
        port,
        options.electronFileUrl,
        options.extraCollections === true,
      );
    case "Accessibility.getFullAXTree":
      return accessibilityTree(options.extraCollections === true);
    case "Debugger.getScriptSource":
      return { scriptSource: "export const observed = 'source-secret';" };
    case "Network.getResponseBody":
      return options.invalidResponseBodyBase64 === true
        ? { body: "%%%not-base64%%%", base64Encoded: true }
        : {
            body: JSON.stringify({
              result: { ok: true, token: "response-body-secret" },
              items: [{ id: 1 }, { id: 2 }],
            }),
            base64Encoded: false,
          };
    case "Page.captureScreenshot":
      return {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==",
      };
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
  ...(target.openerId === undefined ? {} : { openerId: target.openerId }),
  ...(target.parentFrameId === undefined
    ? {}
    : { parentFrameId: target.parentFrameId }),
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
  electronFileUrl?: string,
  duplicateElectronInventory = false,
): Readonly<Record<string, unknown>> => ({
  frameTree: {
    frame: {
      id: "frame-main",
      loaderId: "loader-main",
      url: electronFileUrl ?? `http://127.0.0.1:${String(port)}/app`,
    },
    resources: [
      {
        url:
          electronFileUrl === undefined
            ? `http://127.0.0.1:${String(port)}/app.js?token=script-secret`
            : new URL("app.js", electronFileUrl).href,
        type: "Script",
        mimeType: "text/javascript",
        contentSize: 128,
      },
      ...(duplicateElectronInventory
        ? [
            {
              url:
                electronFileUrl === undefined
                  ? `http://127.0.0.1:${String(port)}/app.js?token=script-secret`
                  : new URL("app.js", electronFileUrl).href,
              type: "Script",
              mimeType: "text/javascript",
              contentSize: 128,
            },
          ]
        : []),
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

const domSnapshot = (
  port: number,
  electronFileUrl?: string,
  extraCollections = false,
): Readonly<Record<string, unknown>> => {
  const secondDocumentUrl =
    electronFileUrl !== undefined && extraCollections
      ? new URL("child.html", electronFileUrl).href
      : "https://private.example.test/frame";
  const strings = [
    electronFileUrl ?? `http://127.0.0.1:${String(port)}/app`,
    "#document",
    "",
    "LINK",
    "token",
    "dom-secret",
    secondDocumentUrl,
    "PRIVATE-TEXT",
    "href",
    "/agent?token=dom-url-secret",
    "rel",
    "mcp",
    "DIV",
    "child text",
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
          attributes: [[], [4, 5, 8, 9, 10, 11]],
        },
      },
      {
        documentURL: 6,
        nodes:
          electronFileUrl !== undefined && extraCollections
            ? {
                nodeType: [9, 1],
                nodeName: [1, 12],
                nodeValue: [2, 13],
                parentIndex: [-1, 0],
                attributes: [[], []],
              }
            : {
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
    if (options.foreignSessionEvents === true)
      event(socket, "Debugger.scriptParsed", "foreign-session", {
        scriptId: "script-foreign",
        url: `http://127.0.0.1:${String(port)}/foreign.js`,
        hash: "foreign-hash",
        length: 20,
        isModule: false,
      });
    event(socket, "Debugger.scriptParsed", command.sessionId, {
      scriptId: "script-allowed",
      url:
        options.electronFileUrl === undefined
          ? `http://127.0.0.1:${String(port)}/app.js?token=script-secret`
          : new URL("app.js", options.electronFileUrl).href,
      hash: "cdp-hash",
      length: 40,
      isModule: true,
      scriptLanguage: "JavaScript",
      sourceMapURL: "/app.js.map?token=map-secret",
    });
    if (
      options.electronFileUrl !== undefined &&
      options.duplicateElectronInventory === true
    )
      event(socket, "Debugger.scriptParsed", command.sessionId, {
        scriptId: "script-allowed-duplicate",
        url: new URL("app.js", options.electronFileUrl).href,
        hash: "cdp-hash",
        length: 40,
        isModule: true,
        scriptLanguage: "JavaScript",
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
        headers: {
          Authorization: "Bearer request-secret",
          "Content-Type": "application/json; charset=utf-8",
        },
        postData: JSON.stringify({
          operation: "lookup",
          token: "request-body-secret",
          filters: { active: true },
        }),
      },
      initiator: {
        type: "script",
        stack: {
          callFrames: [
            {
              url: `http://127.0.0.1:${String(port)}/app.js?caller=caller-secret`,
              lineNumber: 3,
              columnNumber: 5,
            },
          ],
        },
      },
    });
    if (options.redirectToDisallowedOrigin === true)
      event(socket, "Network.requestWillBeSent", command.sessionId, {
        requestId: "request-1",
        type: "Fetch",
        request: {
          url: "https://private.example.test/redirected",
          method: "GET",
        },
      });
    event(socket, "Network.responseReceived", command.sessionId, {
      requestId: "request-1",
      response: {
        url:
          options.redirectToDisallowedOrigin === true
            ? "https://private.example.test/redirected"
            : url,
        status: 200,
        mimeType: "application/json",
        headers: {
          "Set-Cookie": "response-secret",
          "Content-Length": "321",
          "Content-Encoding": "br",
          "Content-Security-Policy":
            "default-src 'self' https:; script-src 'nonce-csp-secret' 'sha256-hash-secret' https://private.example.test https://127.0.0.1",
          Link: `</agent?token=link-secret>; rel="mcp service-desc"; type="application/json", <https://private.example.test/agent>; rel="mcp"`,
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Permissions-Policy": "camera=(), geolocation=(self)",
          "X-Model-Context": "header-secret",
        },
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
      response: {
        opcode: 1,
        payloadData:
          options.sensitiveShapes === true
            ? JSON.stringify({
                event: "updated",
                token: "websocket-secret",
                payload: { count: 2 },
              })
            : "websocket-secret",
      },
    });
    if (options.binaryWebSocketEvent === true)
      event(socket, "Network.webSocketFrameReceived", command.sessionId, {
        requestId: "websocket-1",
        response: {
          opcode: 2,
          payloadData:
            options.invalidBinaryWebSocketEvent === true ? "%%%" : "AQID",
        },
      });
  }
  if (command.method === "Runtime.enable") {
    event(socket, "Runtime.consoleAPICalled", command.sessionId, {
      type: "log",
      timestamp: 123,
      args: [
        {
          type: "string",
          value:
            options.sensitiveShapes === true
              ? "authorization=Bearer console-secret"
              : "console-secret",
        },
        ...(options.sensitiveShapes === true
          ? [
              { type: "number", value: 42 },
              {
                type: "object",
                objectId: "must-not-be-expanded",
                description: "object-secret",
              },
            ]
          : []),
      ],
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
  if (command.method === "WebMCP.enable" && options.webMcpTools === true) {
    event(socket, "WebMCP.toolsAdded", command.sessionId, {
      tools: [
        {
          name: "search_orders",
          description: "Search orders; authorization=Bearer tool-secret",
          frameId: "frame-main",
          backendNodeId: 42,
          inputSchema: {
            type: "object",
            properties: {
              orderId: { type: "string", example: "schema-secret" },
              includeItems: { type: "boolean", default: true },
            },
            required: ["orderId"],
          },
          annotations: {
            readOnly: true,
            untrustedContent: true,
            autosubmit: false,
          },
          stackTrace: {
            callFrames: [
              {
                url: `http://127.0.0.1:${String(port)}/app.js?token=tool-source-secret`,
                lineNumber: 12,
                columnNumber: 4,
              },
            ],
          },
        },
        {
          name: "private_tool",
          description: "private-tool-secret",
          frameId: "frame-private",
        },
        ...(options.extraCollections === true
          ? [
              {
                name: "update_order",
                description: "Update an order",
                frameId: "frame-main",
                inputSchema: {
                  type: "object",
                  properties: { orderId: { type: "string" } },
                },
              },
            ]
          : []),
        ...(options.webMcpChildLeavesScope === true
          ? [
              {
                name: "child_tool",
                description: "Must be removed after child navigation",
                frameId: "frame-child",
              },
            ]
          : []),
      ],
    });
    if (options.webMcpChildLeavesScope === true) {
      event(socket, "Page.frameNavigated", command.sessionId, {
        frame: {
          id: "frame-child",
          parentId: "frame-main",
          url: "https://private.example.test/escaped",
        },
      });
      event(socket, "WebMCP.toolsAdded", command.sessionId, {
        tools: [
          {
            name: "escaped_child_tool",
            description: "cross-origin-child-secret",
            frameId: "frame-child",
          },
        ],
      });
    }
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
  if (
    command.method === "Page.captureScreenshot" &&
    options.navigateDuringScreenshotUrl !== undefined
  )
    event(socket, "Page.frameNavigated", command.sessionId, {
      frame: {
        id: "frame-main",
        url: options.navigateDuringScreenshotUrl,
      },
    });
  if (
    command.method === "Page.setLifecycleEventsEnabled" &&
    options.sessionTimeline !== undefined
  ) {
    const allowed = `http://127.0.0.1:${String(port)}/reloaded?token=session-secret`;
    event(socket, "Page.frameRequestedNavigation", command.sessionId, {
      frameId: "frame-main",
      url: allowed,
      reason: "reload",
      timestamp: 10,
    });
    event(socket, "Page.frameNavigated", command.sessionId, {
      frame: {
        id: "frame-main",
        loaderId: "loader-reload",
        url: allowed,
        transitionType: "reload",
      },
      timestamp: 11,
    });
    event(socket, "Page.navigatedWithinDocument", command.sessionId, {
      frameId: "frame-main",
      url: `${allowed}#spa-secret`,
      navigationType: "historyApi",
      timestamp: 12,
    });
    const redirectUrl =
      options.sessionTimeline === "outside_policy"
        ? "https://private.example.test/outside?token=redirect-secret"
        : `http://127.0.0.1:${String(port)}/redirected?token=redirect-secret`;
    event(socket, "Network.requestWillBeSent", command.sessionId, {
      requestId: "document-request",
      frameId: "frame-main",
      loaderId: "loader-redirect",
      request: { url: redirectUrl, method: "GET" },
      redirectResponse: { status: 302 },
      timestamp: 13,
    });
    event(socket, "Network.loadingFailed", command.sessionId, {
      requestId: "failed-request",
      frameId: "frame-main",
      loaderId: "loader-reload",
      errorText: "net::ERR_CONNECTION_REFUSED",
      timestamp: 14,
    });
    event(socket, "Page.lifecycleEvent", command.sessionId, {
      frameId: "frame-main",
      loaderId: "loader-reload",
      name: "networkIdle",
      timestamp: 15,
    });
  }
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
