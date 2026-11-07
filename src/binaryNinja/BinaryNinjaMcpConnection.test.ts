import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import type { BinaryNinjaConfiguration } from "./BinaryNinjaConfiguration.js";
import {
  BinaryNinjaToolError,
  createBinaryNinjaMcpConnection,
  createBinaryNinjaRedactor,
  decodeBinaryNinjaToolResult,
} from "./BinaryNinjaMcpConnection.js";

const TOKEN = "bn-secret-token-123";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Loopback server that enforces the real GUI server's protocol and bearer checks. */
const startServer = async (
  onRequest?: (method: string) => void,
  toolError = "No matching function was found",
) => {
  const seen: {
    authorization: string | undefined;
    protocol: string | undefined;
  }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const authorization = request.headers.authorization;
    const protocol = request.headers["mcp-protocol-version"];
    seen.push({
      authorization,
      protocol: typeof protocol === "string" ? protocol : undefined,
    });
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    if (authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { "Content-Type": "text/plain" });
      response.end(`rejected authorization ${String(authorization)}`);
      return;
    }
    if (protocol !== undefined && protocol !== "2025-11-25") {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Unsupported MCP-Protocol-Version");
      return;
    }
    const message = JSON.parse(body) as {
      id?: number;
      method: string;
      params?: { name?: string };
    };
    onRequest?.(message.method);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "binaryninja_ui_mcp", version: "0.1.0" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: ["bn_function_info", "bn_memory_read"].map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      };
    else if (message.params?.name === "bn_function_info")
      result = {
        content: [
          {
            type: "text",
            text: '{"errorCode":"function_not_found","errorMessage":"No matching function was found"}',
          },
        ],
        structuredContent: {
          errorCode: "function_not_found",
          errorMessage: toolError,
        },
        isError: true,
      };
    else
      result = {
        content: [{ type: "text", text: '{"bytesRead":0}' }],
        structuredContent: { bytesRead: 0 },
      };
    response.writeHead(200, {
      "Content-Type": "application/json",
      "MCP-Session-Id": "fixture-session",
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP listener");
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${String(address.port)}/mcp`, seen };
};

const config = (url: string, token = TOKEN): BinaryNinjaConfiguration => ({
  url,
  headers: { Authorization: `Bearer ${token}` },
  timeoutMs: 5000,
  maxInputBytes: 1024,
});

describe("Binary Ninja MCP connection", () => {
  it("negotiates the server's protocol, authenticates, and keeps producer error codes", async () => {
    const { url, seen } = await startServer();
    const connection = createBinaryNinjaMcpConnection(config(url));
    expect(await connection.connect()).toEqual([
      "bn_function_info",
      "bn_memory_read",
    ]);
    expect(connection.serverInfo()).toEqual({
      name: "binaryninja_ui_mcp",
      version: "0.1.0",
    });
    expect(await connection.call("bn_memory_read", {})).toEqual({
      text: '{"bytesRead":0}',
      structured: { bytesRead: 0 },
    });
    const failure = await connection
      .call("bn_function_info", { function: "0x1" })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(BinaryNinjaToolError);
    expect(failure).toMatchObject({ code: "function_not_found" });
    expect(
      seen.every(({ authorization }) => authorization === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(seen.some(({ protocol }) => protocol === "2025-11-25")).toBe(true);
    await connection.close();
  });

  it("never reports the configured token in transport failures", async () => {
    const { url } = await startServer();
    const connection = createBinaryNinjaMcpConnection(
      config(url, "wrong-secret-456 "),
    );
    const failure = await connection.connect().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    const serialized = JSON.stringify({
      message: (failure as Error).message,
      diagnostics: (failure as { diagnostics?: unknown }).diagnostics,
      cause: ((failure as Error).cause as Error | undefined)?.message,
    });
    expect(serialized).not.toContain("wrong-secret-456");
  });
});

describe("Binary Ninja tool results", () => {
  it("redacts normalized credentials in decoded errors and preserves ordinary text", async () => {
    const { url } = await startServer(
      undefined,
      `rejected Bearer ${TOKEN}; application/json`,
    );
    const registration = config(url, TOKEN + " ");
    const connection = createBinaryNinjaMcpConnection({
      ...registration,
      headers: { ...registration.headers, Accept: "application/json" },
    });
    try {
      await connection.connect();
      const failure = await connection
        .call("bn_function_info", {})
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(BinaryNinjaToolError);
      expect(JSON.stringify(failure)).not.toContain(TOKEN);
      expect((failure as Error).message).toContain("application/json");
      expect(
        decodeBinaryNinjaToolResult("bn_x", {
          content: [{ type: "text", text: TOKEN }],
        }).text,
      ).toBe(TOKEN);
    } finally {
      await connection.close();
    }
  });

  it("rejects an error without a machine-readable code and non-text content", () => {
    expect(() =>
      decodeBinaryNinjaToolResult("bn_x", {
        isError: true,
        content: [{ type: "text", text: "boom" }],
      }),
    ).toThrow(AnalysisProtocolError);
    expect(() =>
      decodeBinaryNinjaToolResult("bn_x", {
        content: [{ type: "image", data: "", mimeType: "image/png" }],
      }),
    ).toThrow(AnalysisProtocolError);
  });

  it("redacts both a header value and a bare bearer token", () => {
    const redact = createBinaryNinjaRedactor({ Authorization: "Bearer abc" });
    expect(redact("sent Bearer abc and abc")).toBe(
      "sent [redacted] and [redacted]",
    );
  });
});

it.each(["before", "connect", "call"])(
  "preserves the caller cancellation cause at the transport boundary: %s",
  async (stage) => {
    const controller = new AbortController();
    const reason = { source: "caller", operation: stage };
    const { url, seen } = await startServer((method) => {
      if (
        (stage === "connect" && method === "initialize") ||
        (stage === "call" && method === "tools/call")
      )
        controller.abort(reason);
    });
    const connection = createBinaryNinjaMcpConnection(config(url));
    try {
      if (stage === "call") await connection.connect();
      if (stage === "before") controller.abort(reason);
      const failure = await (
        stage === "call"
          ? connection.call("bn_memory_read", {}, controller.signal)
          : connection.connect(controller.signal)
      ).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ _tag: "AnalysisCancelledError" });
      expect((failure as Error).cause).toBe(reason);
      if (stage === "before") expect(seen).toHaveLength(0);
    } finally {
      await connection.close();
    }
  },
);
