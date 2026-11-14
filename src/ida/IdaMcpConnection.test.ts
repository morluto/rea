import { inspect } from "node:util";
import {
  Client,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIdaMcpConnection,
  decodeIdaToolResult,
} from "./IdaMcpConnection.js";
import { createIdaDiagnosticRedactor } from "./IdaDiagnosticRedactor.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { readSettledHealth } from "./IdaBusyHealth.js";

describe("upstream IDA tool result decoding", () => {
  it("leaves successful legacy, structured, and native evidence unchanged", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs: 1000,
    });
    const evidence = "Caller-selected fixture-secret evidence";
    expect(
      decodeIdaToolResult(
        { content: [{ type: "text", text: evidence }] },
        undefined,
        redact,
      ),
    ).toBe(evidence);
    expect(
      decodeIdaToolResult(
        { content: [], structuredContent: { evidence } },
        undefined,
        redact,
      ),
    ).toEqual({ evidence });
    expect(
      decodeIdaToolResult(
        { content: [{ type: "text", text: JSON.stringify({ evidence }) }] },
        "native",
        redact,
      ),
    ).toEqual({ evidence });
  });
  it("redacts credentials in truncated-output diagnostics before constructing the error", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs: 1000,
    });
    expect(() =>
      decodeIdaToolResult(
        {
          content: [],
          _meta: {
            ida_mcp: {
              output_truncated: true,
              download_hint:
                "Download /caller/output?cursor=kept using Bearer fixture-secret",
            },
          },
        },
        undefined,
        redact,
      ),
    ).toThrow(
      "Download /caller/output?cursor=kept using [redacted transport credential]",
    );
  });
  it("decodes scalar wrappers and legacy text without dropping structured dictionaries", () => {
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { result: [{ address: "0x1" }] },
      }),
    ).toEqual([{ address: "0x1" }]);
    expect(
      decodeIdaToolResult({ content: [{ type: "text", text: '{"data":[]}' }] }),
    ).toEqual({ data: [] });
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { result: "code" },
      }),
    ).toBe("code");
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { path: "input", result: "field" },
      }),
    ).toEqual({ path: "input", result: "field" });
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: '[{"address":"0x1000"}]' }],
      }),
    ).toEqual([{ address: "0x1000" }]);
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: "int main(void);" }],
      }),
    ).toBe("int main(void);");
  });
  it("preserves upstream failures and rejects truncated previews that still satisfy item schemas", () => {
    expect(() => decodeIdaToolResult({ content: [] })).toThrow(
      "empty observation",
    );
    expect(() =>
      decodeIdaToolResult({
        isError: true,
        content: [{ type: "text", text: "Decompiler license is unavailable" }],
      }),
    ).toThrow("Decompiler license is unavailable");
    expect(() =>
      decodeIdaToolResult({
        isError: false,
        structuredContent: {
          result: [{ addr: "0x1000", name: "main", size: "0x20" }],
        },
        content: [{ type: "text", text: "preview" }],
        _meta: {
          ida_mcp: {
            output_truncated: true,
            total_chars: 70000,
            download_hint: "Download the full upstream output",
          },
        },
      }),
    ).toThrow("Download the full upstream output");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const failingHttpConnection = (
  credential: string,
  response: Response | Error,
) => {
  // Exercise the real SDK consumer with an explicitly simulated Fetch boundary.
  vi.stubGlobal(
    "fetch",
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response),
  );
  return createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Custom " + credential },
      mode: "attached",
      timeoutMs: 1000,
    },
    {},
  );
};

interface MockedIdaHttpRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const jsonRpcResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

const stalledResponse = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    const aborted = () =>
      reject(new DOMException("The request was aborted", "AbortError"));
    if (signal?.aborted === true) {
      aborted();
      return;
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });

const mockedHttpBoundary = ({
  serverName,
  tools,
  call,
  readResource,
}: {
  readonly serverName: string;
  readonly tools: readonly {
    readonly name: string;
    readonly inputSchema: object;
  }[];
  readonly call: (
    request: MockedIdaHttpRequest,
    signal: AbortSignal | null | undefined,
  ) => Response | Promise<Response>;
  readonly readResource?: (request: MockedIdaHttpRequest) => unknown;
}): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = JSON.parse(
        String(init?.body ?? ""),
      ) as MockedIdaHttpRequest;
      if (request.method === "initialize")
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: serverName, version: "1" },
          },
        });
      if (
        request.method === "notifications/initialized" ||
        request.method === "notifications/cancelled"
      )
        return new Response(null, { status: 202 });
      if (request.method === "tools/list")
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools },
        });
      if (request.method === "tools/call") return call(request, init?.signal);
      if (request.method === "resources/read" && readResource !== undefined)
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: readResource(request),
        });
      throw new Error(`Unexpected fixture request: ${request.method}`);
    }),
  );
};

it("preserves the SDK request timeout as a typed IDA timeout", async () => {
  const timeoutMs = 1000;
  const pendingCall = vi.fn();
  const requestTimeoutMs = 40;
  mockedHttpBoundary({
    serverName: "ida-timeout-fixture",
    tools: [],
    call: (_request, signal) => {
      pendingCall();
      return stalledResponse(signal);
    },
  });
  const connection = createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs,
    },
    {},
  );
  try {
    await expect(connection.connect()).resolves.toEqual([]);
    const failure = await connection
      .call("decompile", {}, { timeoutMs: requestTimeoutMs })
      .catch((cause: unknown) => cause);
    expect(pendingCall).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(AnalysisTimeoutError);
    expect(failure).toMatchObject({
      operation: "decompile",
      timeoutMs: requestTimeoutMs,
      userMessage: expect.stringContaining("40 ms"),
      remediationAction: expect.stringContaining("REA_IDA_MCP_CONFIG"),
    });
    expect(
      failure instanceof AnalysisTimeoutError ? failure.userMessage : "",
    ).toContain("1000 ms");
    if (!(failure instanceof AnalysisTimeoutError))
      throw new Error("Expected a typed IDA request timeout");
    expect(failure.cause).toBeInstanceOf(Error);
    expect(inspectRetainedError(failure)).not.toContain("fixture-secret");
  } finally {
    await connection.close();
  }
});

it("bounds a stalled health poll by the remaining readiness deadline", async () => {
  const timeoutMs = 800;
  let clockNow = 0;
  const clock = {
    now: () => clockNow,
    delay: async (ms: number) => {
      clockNow += ms;
    },
  };
  let pendingCalls = 0;
  const busy = {
    status: "busy",
    busy_tool: "config_json_get",
    busy_sec: 1,
    queued_calls: 0,
  };
  mockedHttpBoundary({
    serverName: "ida-health-deadline-fixture",
    tools: [{ name: "server_health", inputSchema: { type: "object" } }],
    call: (request, signal) => {
      pendingCalls += 1;
      if (pendingCalls === 1) {
        clockNow += 450;
        const result = {
          content: [{ type: "text", text: JSON.stringify(busy) }],
          structuredContent: busy,
        };
        return jsonRpcResponse({ jsonrpc: "2.0", id: request.id, result });
      }
      return stalledResponse(signal);
    },
  });
  const connection = createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: {},
      mode: "headless",
      timeoutMs,
    },
    {},
  );
  try {
    await connection.connect();
    const failure = await readSettledHealth(connection, {
      database: "fixture-db",
      timeoutMs,
      clock,
    }).catch((cause: unknown) => cause);

    expect(pendingCalls).toBe(2);
    expect(failure).toBeInstanceOf(AnalysisTimeoutError);
    expect(failure).toMatchObject({
      operation: "server_health",
      timeoutMs,
      userMessage: expect.stringContaining("800 ms"),
      remediationAction: expect.stringContaining("timeoutMs"),
      cause: busy,
      diagnostics: {
        busy_tool: "config_json_get",
        health_request_operation: "server_health",
        health_request_timeout_ms: 250,
      },
    });
    if (!(failure instanceof AnalysisTimeoutError))
      throw new Error("Expected the readiness deadline to expire");
    expect(failure.userMessage).toContain("config_json_get");
    expect(failure.capturedOutput).toBeDefined();
  } finally {
    await connection.close();
  }
});

const inspectRetainedError = (error: unknown): string =>
  inspect(error, { depth: null, maxStringLength: null, breakLength: Infinity });

describe("retained IDA diagnostic errors", () => {
  it.each([
    {
      credential: "fixture-secret",
      body: '{"reason":"fixture-secret at /caller/input",',
      forbidden: "fixture-secret",
    },
    {
      credential: "<token>",
      body: String.raw`["\u003ctoken\u003e",x]`,
      forbidden: "u003ctoken",
    },
  ])(
    "retains only sanitized malformed HTTP JSON: $credential",
    async ({ credential, body, forbidden }) => {
      const connection = failingHttpConnection(
        credential,
        new Response(body, { headers: { "Content-Type": "application/json" } }),
      );
      const failure: unknown = await connection
        .connect()
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error))
        throw new Error("Expected a malformed HTTP JSON failure");
      expect(failure.message).toContain("[redacted transport credential]");
      expect(inspectRetainedError(failure)).not.toContain(forbidden);
      expect(inspectRetainedError(failure)).not.toContain(credential);
      await connection.close();
    },
  );

  it("does not rescan an owned malformed JSON replacement marker", async () => {
    const connection = failingHttpConnection(
      "redacted",
      new Response("Rejected redacted", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const failure: unknown = await connection
      .connect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error("Expected a malformed HTTP JSON failure");
    expect(failure.message).toBe(
      "IDA MCP returned malformed HTTP JSON. Response body: \nRejected ␟",
    );
    expect(inspectRetainedError(failure)).not.toContain("[[redacted");
    await connection.close();
  });

  it("replaces an unknown network error graph with a safe owned reason", async () => {
    const upstream = Object.assign(
      new Error("fixture-secret refused at /caller/input", {
        cause: new Error("nested fixture-secret"),
      }),
      { headers: { Authorization: "Custom fixture-secret" } },
    );
    const connection = failingHttpConnection("fixture-secret", upstream);
    const failure: unknown = await connection
      .connect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error("Expected a network failure");
    expect(failure.message).toContain("refused at /caller/input");
    expect(failure.cause).not.toBe(upstream);
    expect(inspectRetainedError(failure)).not.toContain("fixture-secret");
    await connection.close();
  });

  it("retains meaningful HTTP status without unsafe SDK metadata", async () => {
    const connection = failingHttpConnection(
      "fixture-secret",
      new Response("unavailable fixture-secret at /caller/input", {
        status: 500,
        statusText: "fixture-secret",
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const failure: unknown = await connection
      .connect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error("Expected an HTTP failure");
    expect(failure.cause).toMatchObject({ data: { status: 500 } });
    expect(failure.message).toContain(
      "unavailable [redacted transport credential] at /caller/input",
    );
    expect(inspectRetainedError(failure)).not.toContain("fixture-secret");
    await connection.close();
  });
});

const withIdaResource = async (
  response: unknown,
  verify: (
    connection: ReturnType<typeof createIdaMcpConnection>,
  ) => Promise<void>,
): Promise<void> => {
  mockedHttpBoundary({
    serverName: "ida-resource-fixture",
    tools: [],
    call: () => {
      throw new Error("Unexpected tool call");
    },
    readResource: () => response,
  });
  const connection = createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: {},
      mode: "attached",
      timeoutMs: 1000,
    },
    {},
  );
  try {
    await connection.connect();
    await verify(connection);
  } finally {
    await connection.close();
  }
};

it.each([
  {
    code: SdkErrorCode.ClientHttpNotImplemented,
    message: "Changed SDK context: fixture-secret",
  },
  {
    code: SdkErrorCode.ClientHttpFailedToOpenStream,
    message: "Error POSTing to endpoint: fixture-secret",
  },
])(
  "does not infer owned body spans from an unknown SDK shape: $code / $message",
  async ({ code, message }) => {
    const connection = failingHttpConnection(
      "fixture-secret",
      new SdkHttpError(code, message, { status: 500, text: "fixture-secret" }),
    );
    try {
      const failure = await connection
        .connect()
        .catch((cause: unknown) => cause);
      if (!(failure instanceof Error)) throw new Error("Expected SDK failure");
      expect(inspectRetainedError(failure)).not.toContain("fixture-secret");
      expect(failure.message).toContain("[redacted transport credential]");
      expect(failure.cause).toMatchObject({ code, data: { status: 500 } });
    } finally {
      await connection.close();
    }
  },
);

it("redacts JSON character candidates in unclassified SDK errors", async () => {
  const connection = failingHttpConnection(
    'q"uote',
    new Error(String.raw`network context {"error":"q\"uote"} at /caller/input`),
  );
  try {
    const failure = await connection.connect().catch((cause: unknown) => cause);
    if (!(failure instanceof Error)) throw new Error("Expected SDK failure");
    expect(failure.message).toContain(
      '{"error":"[redacted transport credential]"} at /caller/input',
    );
    expect(inspectRetainedError(failure)).not.toContain(String.raw`q\"uote`);
  } finally {
    await connection.close();
  }
});

it("owns unclassified truncated-output hints separately from their context", () => {
  const diagnostic = createIdaDiagnosticRedactor({
    url: "http://127.0.0.1:12345/mcp",
    mode: "attached",
    timeoutMs: 1000,
    headers: { Authorization: 'Custom q"uote' },
  });
  let failure: unknown;
  try {
    decodeIdaToolResult(
      {
        content: [],
        _meta: {
          ida_mcp: {
            output_truncated: true,
            download_hint: String.raw`{"error":"q\"uote","path":"/caller/output"}`,
          },
        },
      },
      undefined,
      diagnostic,
    );
  } catch (cause: unknown) {
    failure = cause;
  }
  if (!(failure instanceof Error))
    throw new Error("Expected truncation failure");
  expect(failure.message).toContain(
    '{"error":"[redacted transport credential]","path":"/caller/output"}',
  );
  expect(inspectRetainedError(failure)).not.toContain(String.raw`q\"uote`);
});

it.each([
  undefined,
  "application/json",
  "Application/JSON",
  "application/json; charset=utf-8",
])(
  "accepts SDK JSON metadata resources with media type %s",
  async (mimeType) => {
    await withIdaResource(
      {
        contents: [
          {
            uri: "ida://idb/metadata",
            ...(mimeType === undefined ? {} : { mimeType }),
            text: '{"sha256":"recorded"}',
          },
        ],
      },
      async (connection) => {
        if (connection.readResource === undefined)
          throw new Error("IDA connection does not support resource reads");
        await expect(
          connection.readResource("ida://idb/metadata"),
        ).resolves.toEqual({ sha256: "recorded" });
      },
    );
  },
);
it("keeps JSON resource identity, media type and JSON parsing strict", async () => {
  const resource = (uri: string, mimeType: string, text: string) => ({
    contents: [{ uri, mimeType, text }],
  });
  for (const [reply, message] of [
    [
      resource("wrong://resource", "application/json", "{}"),
      /ida:\/\/idb\/metadata/u,
    ],
    [
      resource("ida://idb/metadata", "text/plain", "{}"),
      /Expected a JSON resource media type/u,
    ],
    [
      resource("ida://idb/metadata", "application/json", "not JSON"),
      /IDA MCP returned malformed JSON text/u,
    ],
  ] as const)
    await withIdaResource(reply, async (connection) => {
      if (connection.readResource === undefined)
        throw new Error("IDA connection does not support resource reads");
      await expect(
        connection.readResource("ida://idb/metadata"),
      ).rejects.toThrow(message);
    });
});

it("uses the actual SDK abort outcome to preserve the caller reason", async () => {
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  mockedHttpBoundary({
    serverName: "ida-abort-fixture",
    tools: [],
    call: (_request, signal) => {
      started();
      return stalledResponse(signal);
    },
  });
  const connection = createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: {},
      mode: "attached",
      timeoutMs: 1000,
    },
    {},
  );
  const controller = new AbortController();
  const reason = { caller: "exact opaque reason" };
  try {
    await connection.connect();
    const pending = connection
      .call("decompile", {}, { signal: controller.signal })
      .catch((cause: unknown) => cause);
    await requestStarted;
    controller.abort(reason);
    const failure = await pending;
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    if (!(failure instanceof AnalysisCancelledError))
      throw new Error("Expected SDK-owned cancellation");
    expect(failure.operation).toBe("decompile");
    expect(failure.cause).toBe(reason);
    expect(failure.capturedOutput).toMatchObject({
      stderr: "",
      truncated: false,
    });
  } finally {
    await connection.close();
  }
});

it("keeps a real SDK physical failure when abort arrives during its outer unwind", async () => {
  const controller = new AbortController();
  const reason = { caller: "late abort" };
  mockedHttpBoundary({
    serverName: "ida-failure-first-fixture",
    tools: [],
    call: (request) =>
      jsonRpcResponse({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "established producer failure" },
      }),
  });
  const callTool = Client.prototype.callTool;
  const spy = vi
    .spyOn(Client.prototype, "callTool")
    .mockImplementation(function (this: Client, params, options) {
      return callTool.call(this, params, options).catch((cause: unknown) => {
        // The SDK has already rejected this request. Delay only its outer unwind.
        queueMicrotask(() => controller.abort(reason));
        throw cause;
      });
    });
  const connection = createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: {},
      mode: "attached",
      timeoutMs: 1000,
    },
    {},
  );
  try {
    await connection.connect();
    const failure = await connection
      .call("decompile", {}, { signal: controller.signal })
      .catch((cause: unknown) => cause);
    expect(controller.signal.aborted).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AnalysisCancelledError);
    expect(failure).toMatchObject({
      message: expect.stringContaining("established producer failure"),
    });
  } finally {
    spy.mockRestore();
    await connection.close();
  }
});

it.each(["1e400", '{"observed":1e400}'])(
  "rejects IDA JSON text outside the JSON value contract: %s",
  (text) => {
    expect(() =>
      decodeIdaToolResult({ content: [{ type: "text", text }] }),
    ).toThrow("JSON numbers must be finite");
  },
);

it("preserves observed own structured members before deciding whether to unwrap a result", () => {
  const structured: unknown = JSON.parse(
    '{"__proto__":{"observed":true},"result":"field","nested":[{"__proto__":"nested fact"}]}',
  );
  const decoded = decodeIdaToolResult({
    content: [],
    structuredContent: structured,
  });
  expect(Object.hasOwn(decoded as object, "__proto__")).toBe(true);
  expect(JSON.stringify(decoded)).toBe(JSON.stringify(structured));
  const wrapped: unknown = JSON.parse(
    '{"result":{"__proto__":{"observed":true},"nested":{"__proto__":"nested fact"}}}',
  );
  const value = decodeIdaToolResult({
    content: [],
    structuredContent: wrapped,
  });
  expect(Object.hasOwn(value as object, "__proto__")).toBe(true);
  expect(JSON.stringify(value)).toBe(
    '{"__proto__":{"observed":true},"nested":{"__proto__":"nested fact"}}',
  );
});

it("keeps error, truncation and native-text precedence ahead of structured JSON admission", () => {
  const structuredContent = { result: Infinity };
  expect(() =>
    decodeIdaToolResult({
      isError: true,
      structuredContent,
      content: [{ type: "text", text: "engine refused" }],
    }),
  ).toThrow(/IDA MCP tool failed: \s*engine refused/u);
  expect(() =>
    decodeIdaToolResult({
      structuredContent,
      content: [],
      _meta: { ida_mcp: { output_truncated: true } },
    }),
  ).toThrow("IDA MCP truncated its output");
  expect(
    decodeIdaToolResult(
      {
        structuredContent,
        content: [{ type: "text", text: '{"complete":true}' }],
      },
      "native",
    ),
  ).toEqual({ complete: true });
});

it("requires a valid content array even when IDA supplies structured evidence", () => {
  for (const content of [
    "invalid",
    undefined,
    null,
    {},
    [null],
    [{ type: "text", text: 42 }],
  ])
    expect(() =>
      decodeIdaToolResult({ content, structuredContent: { observed: true } }),
    ).toThrow();
});

it("selects structured IDA evidence ahead of text while admitting mixed content", () => {
  const image = { type: "image", data: "AA==", mimeType: "image/png" };
  expect(
    decodeIdaToolResult({
      content: [image, { type: "text", text: "fallback" }],
      structuredContent: { observed: true },
    }),
  ).toEqual({ observed: true });
  expect(
    decodeIdaToolResult({
      content: [image, { type: "text", text: "fallback" }],
    }),
  ).toBe("fallback");
  for (const structuredContent of [null, [], "invalid", { observed: Infinity }])
    expect(() =>
      decodeIdaToolResult({
        content: [{ type: "text", text: "fallback" }],
        structuredContent,
      }),
    ).toThrow();
  expect(() => decodeIdaToolResult({ content: [image] })).toThrow(
    "empty observation",
  );
  expect(() =>
    decodeIdaToolResult({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }),
  ).toThrow("empty observation");
});

it("requires complete native IDA JSON text despite usable structured content", () => {
  for (const content of [[], [{ type: "text", text: "plain text" }]])
    expect(() =>
      decodeIdaToolResult(
        { content, structuredContent: { observed: true } },
        "native",
      ),
    ).toThrow();
});

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanupConnection = () =>
  createIdaMcpConnection(
    {
      url: "http://127.0.0.1:12345/mcp",
      headers: {},
      mode: "attached",
      timeoutMs: 1000,
    },
    {},
  );

it("refuses an oversized HTTP error promptly and retains its exact pending cancellation for retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancel = vi.fn(() => gate);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(65537));
            },
            cancel,
          }),
          { status: 500, headers: { "content-type": "text/plain" } },
        ),
    ),
  );
  const connection = cleanupConnection();
  try {
    const failure = await connection.connect().catch((cause: unknown) => cause);
    expect(failure).not.toBeInstanceOf(AnalysisTimeoutError);
    expect(failure).toMatchObject({
      message: expect.stringContaining("exceeds 65536 UTF-8 bytes"),
    });
    const closeFailure = await connection
      .close()
      .catch((cause: unknown) => cause);
    expect(closeFailure).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["IDA MCP HTTP response body"],
    });
    await expect(connection.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
    release();
    await turn();
    await expect(connection.close()).resolves.toBeUndefined();
    expect(closeFailure).toMatchObject({ cleanupIncomplete: false });
  } finally {
    release();
    await turn();
    await connection.close();
  }
});

it("preserves independent transport-close and exact rejected response-cancellation failures", async () => {
  const cancellationFailure = new Error(
    "controlled response cancellation rejected",
  );
  const cancel = vi.fn(async () => {
    throw cancellationFailure;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(65537));
            },
            cancel,
          }),
          { status: 500, headers: { "content-type": "text/plain" } },
        ),
    ),
  );
  const connection = cleanupConnection();
  await connection.connect().catch(() => undefined);
  await turn();
  const transportClose = vi
    .spyOn(Client.prototype, "close")
    .mockRejectedValueOnce(new Error("controlled transport close rejected"));
  try {
    const mixed = await connection.close().catch((cause: unknown) => cause);
    expect(mixed).toBeInstanceOf(AggregateError);
    if (!(mixed instanceof AggregateError))
      throw new Error("Expected both cleanup failures");
    expect(mixed.errors[0]).toMatchObject({
      message: "controlled transport close rejected",
    });
    expect(mixed.errors[1]).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["IDA MCP HTTP response body"],
    });
    const responseFailure = mixed.errors[1] as Error;
    expect(responseFailure.cause).toMatchObject({
      cause: { errors: [cancellationFailure] },
    });
    await expect(connection.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    transportClose.mockRestore();
    // A rejected Web Stream cancel cannot be retried; keep its exact failure.
    await connection.close().catch(() => undefined);
  }
});

it.each([200, 500])(
  "retains an ignored-abort late HTTP %s acquisition and its later body cancellation",
  async (status) => {
    let deliver!: (response: Response) => void;
    let entered!: () => void;
    const enteredFetch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pendingFetch = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(() => cleanup);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        entered();
        return pendingFetch;
      }),
    );
    const connection = cleanupConnection();
    const connecting = connection.connect().catch((cause: unknown) => cause);
    try {
      await enteredFetch;
      await expect(connection.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: ["IDA MCP HTTP response acquisition"],
      });
      deliver(
        new Response(new ReadableStream<Uint8Array>({ cancel }), { status }),
      );
      await connecting;
      await turn();
      await expect(connection.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: ["IDA MCP HTTP response body"],
      });
      expect(cancel).toHaveBeenCalledOnce();
      release();
      await turn();
      await expect(connection.close()).resolves.toBeUndefined();
    } finally {
      deliver(new Response(null, { status: 500 }));
      release();
      await connecting;
      await turn();
      await connection.close();
    }
  },
);

it("allows SDK transport-close session DELETE traffic to finish its own response", async () => {
  const methods: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as MockedIdaHttpRequest;
      if (request.id === undefined) return new Response(null, { status: 202 });
      const response = jsonRpcResponse({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "initialize"
            ? {
                protocolVersion: request.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "close-traffic-fixture", version: "1" },
              }
            : { tools: [] },
      });
      response.headers.set("mcp-session-id", "owned-fixture-session");
      return response;
    }),
  );
  const connection = cleanupConnection();
  await connection.connect();
  const originalClose = StreamableHTTPClientTransport.prototype.close;
  const close = vi
    .spyOn(StreamableHTTPClientTransport.prototype, "close")
    .mockImplementationOnce(async function (
      this: StreamableHTTPClientTransport,
    ) {
      await this.terminateSession();
      await originalClose.call(this);
    });
  try {
    await expect(connection.close()).resolves.toBeUndefined();
    expect(methods).toContain("DELETE");
  } finally {
    close.mockRestore();
    await connection.close();
  }
});

it.each(["completed", "pending", "rejected"] as const)(
  "cancels an acquired parked HTTP error reader at close after deadline with %s cleanup",
  async (outcome) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rejection = new Error(
      "controlled parked-reader cancellation failure",
    );
    const cancel = vi.fn(async () => {
      if (outcome === "pending") await gate;
      if (outcome === "rejected") throw rejection;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode("partial diagnostic"),
                );
              },
              cancel,
            }),
            { status: 500, headers: { "content-type": "text/plain" } },
          ),
      ),
    );
    const connection = createIdaMcpConnection(
      {
        url: "http://127.0.0.1:12345/mcp",
        headers: {},
        mode: "attached",
        timeoutMs: 30,
      },
      {},
    );
    try {
      const failure = await connection
        .connect()
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AnalysisTimeoutError);
      await connection.close().catch(() => undefined);
      await turn();
      expect(cancel).toHaveBeenCalledOnce();
      if (outcome === "completed")
        await expect(connection.close()).resolves.toBeUndefined();
      else {
        const retained = await connection
          .close()
          .catch((cause: unknown) => cause);
        expect(retained).toMatchObject({
          cleanupIncomplete: true,
          cleanupResources: ["IDA MCP HTTP response body"],
        });
        if (outcome === "rejected") {
          expect(retained).toMatchObject({
            cause: { cause: { errors: [rejection] } },
          });
          await expect(connection.close()).rejects.toMatchObject({
            cleanupIncomplete: true,
          });
        } else {
          release();
          await turn();
          await expect(connection.close()).resolves.toBeUndefined();
        }
      }
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      release();
      await turn();
      await connection.close().catch(() => undefined);
    }
  },
);

it("closes an acquired parked error reader after caller abort and preserves the exact reason", async () => {
  let entered!: () => void;
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancel = vi.fn(() => gate);
  mockedHttpBoundary({
    serverName: "parked-error-abort-fixture",
    tools: [],
    call: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial diagnostic"));
          },
          pull() {
            entered();
          },
          cancel,
        }),
        { status: 500, headers: { "content-type": "text/plain" } },
      ),
  });
  const connection = cleanupConnection();
  const controller = new AbortController();
  const reason = { caller: "parked diagnostic abort" };
  try {
    await connection.connect();
    const calling = connection
      .call("decompile", {}, { signal: controller.signal })
      .catch((cause: unknown) => cause);
    await parked;
    controller.abort(reason);
    const failure = await calling;
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect(failure).toMatchObject({ cause: reason });
    await connection.close().catch(() => undefined);
    await turn();
    expect(cancel).toHaveBeenCalledOnce();
    await expect(connection.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["IDA MCP HTTP response body"],
    });
    release();
    await turn();
    await expect(connection.close()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    release();
    await turn();
    await connection.close().catch(() => undefined);
  }
});
