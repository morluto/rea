import { type WebSocket } from "ws";

import type { FakeCdpCommand, FakeOptions } from "./fakeCdpBrowserTypes.js";

export const emitEvents = (
  socket: WebSocket,
  command: FakeCdpCommand,
  port: number,
  options: FakeOptions,
): void => {
  emitDebuggerEvents(socket, command, port, options);
  emitNetworkEvents(socket, command, port, options);
  emitRuntimeEvents(socket, command, port, options);
  emitWebMcpEvents(socket, command, port, options);
  emitSessionTimeline(socket, command, port, options);
  emitCaptureNavigation(socket, command, options);
};

const emitWebMcpEvents = (
  socket: WebSocket,
  command: FakeCdpCommand,
  port: number,
  options: FakeOptions,
): void => {
  if (command.method === "WebMCP.enable" && options.webMcpTools === true) {
    const inputSchemaProperties =
      options.webMcpSchemaPropertyCount === undefined
        ? {
            orderId: { type: "string", example: "schema-secret" },
            includeItems: { type: "boolean", default: true },
          }
        : Object.fromEntries(
            Array.from(
              { length: options.webMcpSchemaPropertyCount },
              (_value, index) => [`field_${String(index)}`, { type: "string" }],
            ),
          );
    event(socket, "WebMCP.toolsAdded", command.sessionId, {
      tools: [
        {
          name: "search_orders",
          description: "Search orders; authorization=Bearer tool-secret",
          frameId: "frame-main",
          backendNodeId: 42,
          inputSchema: {
            type: "object",
            properties: inputSchemaProperties,
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
        ...(options.webMcpFrameCount !== undefined &&
        options.webMcpFrameCount > 0
          ? [
              {
                name: "beyond_frame_limit_tool",
                description: "Registered in an in-scope frame after index 999",
                frameId: `webmcp-frame-${String(options.webMcpFrameCount - 1)}`,
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
};

const emitSessionTimeline = (
  socket: WebSocket,
  command: FakeCdpCommand,
  port: number,
  options: FakeOptions,
): void => {
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
      type: options.sessionRedirectResourceType,
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
    for (
      let index = 0;
      index < (options.sessionTimelineEventCount ?? 0);
      index += 1
    )
      event(socket, "Page.lifecycleEvent", command.sessionId, {
        frameId: "frame-main",
        loaderId: "loader-reload",
        name: `lifecycle-${String(index)}`,
        timestamp: 16 + index,
      });
    if (options.sessionTimeline === "target_detached")
      event(socket, "Target.detachedFromTarget", undefined, {
        sessionId: command.sessionId,
        targetId: "allowed-page",
      });
  }
};

const emitNetworkEvents = (
  socket: WebSocket,
  command: FakeCdpCommand,
  port: number,
  options: FakeOptions,
): void => {
  if (command.method !== "Network.enable") return;
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
};

const emitDebuggerEvents = (
  socket: WebSocket,
  command: FakeCdpCommand,
  port: number,
  options: FakeOptions,
): void => {
  if (command.method !== "Debugger.enable") return;
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
    executionContextId: 1,
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
      executionContextId: 1,
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
};

const emitRuntimeEvents = (
  socket: WebSocket,
  command: FakeCdpCommand,
  port: number,
  options: FakeOptions,
): void => {
  if (command.method !== "Runtime.enable") return;
  event(socket, "Runtime.executionContextCreated", command.sessionId, {
    context: {
      id: 1,
      origin:
        options.electronFileUrl === undefined
          ? `http://127.0.0.1:${String(port)}`
          : "file://",
      auxData: { frameId: "frame-main", isDefault: true },
    },
  });
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
};

const emitCaptureNavigation = (
  socket: WebSocket,
  command: FakeCdpCommand,
  options: FakeOptions,
): void => {
  const navigationUrl =
    command.method === "DOMSnapshot.captureSnapshot"
      ? options.navigateDuringCaptureUrl
      : command.method === "Page.captureScreenshot"
        ? options.navigateDuringScreenshotUrl
        : undefined;
  if (navigationUrl !== undefined)
    event(socket, "Page.frameNavigated", command.sessionId, {
      frame: { id: "frame-main", url: navigationUrl },
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
