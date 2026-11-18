import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AnalysisCancelledError,
  AnalysisProtocolError,
  AnalysisTimeoutError,
} from "../../../src/domain/analysisErrorCore.js";

import { JebProvider } from "../../../src/jeb/JebProvider.js";
import { JebMcpCleanupFailure } from "../../../src/jeb/JebMcpConnectionOwner.js";

import {
  createStreamableHttpJebMcpConnection,
  type JebMcpConnectionTimeouts,
} from "../../../src/jeb/JebMcpConnection.js";

const requestSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const engineToolNames = [
  "get_client_information",
  "open_project",
  "list_units",
  "decompile_code_item",
] as const;

const fixtureResult = (
  name: string,
  generation: number,
  omitInitialVersion: boolean,
) => {
  switch (name) {
    case "get_client_information":
      return {
        success: true,
        generation,
        ...(omitInitialVersion && generation === 1
          ? {}
          : { version: `fixture-${generation}` }),
        gui_client: generation > 1,
      };
    case "open_project":
      return { success: true, generation, input_files: [], units: [] };
    case "list_units":
      return { success: true, generation, units: [] };
    default:
      return { success: false, message: "Item is missing" };
  }
};

/** Real HTTP/SDK transport with controllable MCP session expiry. */
const startEndpoint = async (
  expiredStatus = 200,
  timeouts?: JebMcpConnectionTimeouts,
  omitInitialVersion = false,
) => {
  let generation = 1;
  let handshakes = 0;
  let session: string | undefined;
  let heldRequest: { method: string; received: () => void } | undefined;
  let catalogs = 0;
  let failureText: string | undefined;
  const calls: string[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      request.resume();
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const message = requestSchema.parse(JSON.parse(body));
      const reply = (payload: object, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }),
        );
      };
      if (message.method === "server/discover") {
        reply({ error: { code: -32601, message: "Method not found" } });
      } else if (message.method === "initialize") {
        handshakes += 1;
        session = `${generation}-${handshakes}`;
        response.setHeader("Mcp-Session-Id", session);
        reply({
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "jeb-session-test", version: "1.0.0" },
          },
        });
      } else if (message.id === undefined) {
        if (
          message.method !== "notifications/initialized" &&
          message.method !== "notifications/cancelled"
        )
          throw new Error(`Unexpected JEB notification: ${message.method}`);
        response.writeHead(202).end();
      } else if (
        message.method === "tools/list" ||
        message.method === "tools/call"
      ) {
        if (message.method === "tools/list") catalogs += 1;
        else calls.push(z.enum(engineToolNames).parse(message.params?.name));
        if (
          session === undefined ||
          request.headers["mcp-session-id"] !== session
        ) {
          reply(
            { error: { code: -32603, message: "Session not found" } },
            expiredStatus,
          );
          return;
        }
        if (heldRequest?.method === message.method) {
          heldRequest.received();
          heldRequest = undefined;
          return;
        }
        if (message.method === "tools/list") {
          reply({
            result: {
              tools: engineToolNames.map((name) => ({
                name,
                inputSchema: { type: "object" },
              })),
            },
          });
        } else {
          const name = z.enum(engineToolNames).parse(message.params?.name);
          if (failureText !== undefined) {
            reply({
              result: {
                isError: true,
                content: [{ type: "text", text: failureText }],
              },
            });
            failureText = undefined;
            return;
          }
          const result = fixtureResult(name, generation, omitInitialVersion);
          reply({
            result: {
              isError: !result.success,
              content: [{ type: "text", text: JSON.stringify(result) }],
            },
          });
        }
      } else {
        reply({ error: { code: -32601, message: "Method not found" } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP listener");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const connection = createStreamableHttpJebMcpConnection(url, timeouts);
  return {
    url,
    connection,
    calls,
    handshakes: () => handshakes,
    catalogs: () => catalogs,
    restart() {
      generation += 1;
      session = undefined;
    },
    failNextCall(message: string) {
      failureText = message;
    },
    holdNextRequest(method = "tools/call") {
      return new Promise<void>((resolve) => {
        heldRequest = { method, received: resolve };
      });
    },
    async close() {
      try {
        await connection.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((cause) =>
            cause === undefined ? resolve() : reject(cause),
          ),
        );
      }
    },
  };
};

it.each([200, 404])(
  "reconnects after session expiry (HTTP %s) on the next explicit call without replaying the failed operation",
  async (status) => {
    const endpoint = await startEndpoint(status);
    try {
      await expect(
        endpoint.connection.call("get_client_information", {}),
      ).resolves.toMatchObject({ success: true, generation: 1 });
      endpoint.restart();
      await expect(
        endpoint.connection.call("open_project", {
          path: "/fixtures/project.jdb2",
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining("Session not found"),
        }),
      });
      expect(endpoint.handshakes()).toBe(1);
      const recovered = await Promise.all([
        endpoint.connection.call("get_client_information", {}),
        endpoint.connection.call("list_units", {}),
      ]);
      expect(recovered).toMatchObject([
        { success: true, generation: 2 },
        { success: true, generation: 2 },
      ]);
      expect(endpoint.handshakes()).toBe(2);
      expect(
        endpoint.calls.filter((name) => name === "open_project"),
      ).toHaveLength(1);
    } finally {
      await endpoint.close();
    }
  },
);

it("reconnects after a catalog refresh loses its session without replaying the refresh", async () => {
  const endpoint = await startEndpoint();
  try {
    await endpoint.connection.connect();
    endpoint.restart();
    await expect(endpoint.connection.listTools()).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Session not found"),
      }),
    });
    expect(endpoint.handshakes()).toBe(1);
    expect(endpoint.catalogs()).toBe(2);
    await expect(endpoint.connection.listTools()).resolves.toEqual([
      "get_client_information",
      "open_project",
      "list_units",
      "decompile_code_item",
    ]);
    expect(endpoint.handshakes()).toBe(2);
    expect(endpoint.catalogs()).toBe(3);
  } finally {
    await endpoint.close();
  }
});

it.each(["tools/call", "tools/list"])(
  "preserves the session failure for an overlapping %s without caller cancellation or replay",
  async (method) => {
    const endpoint = await startEndpoint();
    try {
      await endpoint.connection.connect();
      const received = endpoint.holdNextRequest(method);
      const caller = new AbortController();
      const pending =
        method === "tools/call"
          ? endpoint.connection.call("open_project", {}, caller.signal)
          : endpoint.connection.listTools(caller.signal);
      const rejected = pending.catch((cause: unknown) => cause);
      await received;
      endpoint.restart();
      const failure = await endpoint.connection
        .call("list_units", {})
        .catch((cause: unknown) => cause);
      const overlappingFailure = await rejected;
      expect(caller.signal.aborted).toBe(false);
      expect(overlappingFailure).not.toBeInstanceOf(AnalysisCancelledError);
      expect(failure).toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining("Session not found"),
        }),
      });
      expect(overlappingFailure).toBe(failure);
      expect(endpoint.handshakes()).toBe(1);
      expect(endpoint.calls).toEqual(
        method === "tools/call"
          ? ["open_project", "list_units"]
          : ["list_units"],
      );
      expect(endpoint.catalogs()).toBe(method === "tools/list" ? 2 : 1);
      await expect(
        endpoint.connection.call("get_client_information", {}),
      ).resolves.toMatchObject({ success: true, generation: 2 });
      expect(endpoint.handshakes()).toBe(2);
    } finally {
      await endpoint.close();
    }
  },
);

it.each(["tools/call", "tools/list"])(
  "reconnects after a %s timeout while preserving its typed failure",
  async (method) => {
    const endpoint = await startEndpoint(200, {
      discoveryTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    try {
      await endpoint.connection.connect();
      const received = endpoint.holdNextRequest(method);
      const pending =
        method === "tools/call"
          ? endpoint.connection.call("open_project", {})
          : endpoint.connection.listTools();
      const rejected =
        expect(pending).rejects.toBeInstanceOf(AnalysisTimeoutError);
      await received;
      await rejected;
      expect(endpoint.handshakes()).toBe(1);
      await expect(
        endpoint.connection.call("get_client_information", {}),
      ).resolves.toMatchObject({ success: true, generation: 1 });
      expect(endpoint.handshakes()).toBe(2);
      expect(
        endpoint.calls.filter((name) => name === "open_project"),
      ).toHaveLength(method === "tools/call" ? 1 : 0);
    } finally {
      await endpoint.close();
    }
  },
);

it("retains a working connection after an engine refusal or caller cancellation", async () => {
  const endpoint = await startEndpoint();
  try {
    await expect(
      endpoint.connection.call("decompile_code_item", {}),
    ).resolves.toEqual({
      success: false,
      message: "Item is missing",
    });
    endpoint.failNextCall("Engine could not decode this item");
    await expect(
      endpoint.connection.call("decompile_code_item", {}),
    ).rejects.toBeInstanceOf(AnalysisProtocolError);
    for (const method of ["tools/call", "tools/list"]) {
      const received = endpoint.holdNextRequest(method);
      const cancellation = new AbortController();
      const pending =
        method === "tools/call"
          ? endpoint.connection.call("list_units", {}, cancellation.signal)
          : endpoint.connection.listTools(cancellation.signal);
      const rejected = expect(pending).rejects.toBeInstanceOf(
        AnalysisCancelledError,
      );
      await received;
      cancellation.abort();
      await rejected;
    }
    await expect(
      endpoint.connection.call("get_client_information", {}),
    ).resolves.toMatchObject({ success: true, generation: 1 });
    expect(endpoint.handshakes()).toBe(1);
  } finally {
    await endpoint.close();
  }
});

it("retains the typed timeout when disposal fails and retries owned cleanup before reconnecting", async () => {
  const endpoint = await startEndpoint(200, { requestTimeoutMs: 1_000 });
  const cleanupFailure = new Error("Client cleanup failed");
  const close = vi.spyOn(Client.prototype, "close");
  try {
    await endpoint.connection.connect();
    const catalogReceived = endpoint.holdNextRequest("tools/list");
    const overlapping = endpoint.connection
      .listTools()
      .catch((cause: unknown) => cause);
    await catalogReceived;
    close.mockRejectedValueOnce(cleanupFailure);
    const received = endpoint.holdNextRequest();
    const pending = endpoint.connection.call("open_project", {});
    const rejected = pending.catch((cause: unknown) => cause);
    await received;
    const failure = await rejected;
    expect(failure).toBeInstanceOf(JebMcpCleanupFailure);
    if (!(failure instanceof JebMcpCleanupFailure)) throw failure;
    expect(failure.primaryFailure).toBeInstanceOf(AnalysisTimeoutError);
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toEqual([
      `${endpoint.url} (JEB MCP client)`,
    ]);
    expect(await overlapping).toBe(failure);
    await expect(
      endpoint.connection.call("list_units", {}),
    ).resolves.toMatchObject({
      success: true,
      generation: 1,
    });
    expect(endpoint.handshakes()).toBe(2);
    expect(endpoint.calls).toEqual(["open_project", "list_units"]);
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupResources).toEqual([]);
  } finally {
    close.mockRestore();
    await endpoint.close();
  }
});

it("retains failed cleanup ownership and does not reuse the invalid session before cleanup succeeds", async () => {
  const endpoint = await startEndpoint();
  const cleanupFailure = new Error("Client cleanup failed");
  const close = vi.spyOn(Client.prototype, "close");
  try {
    await endpoint.connection.call("get_client_information", {});
    const received = endpoint.holdNextRequest();
    const overlapping = endpoint.connection
      .call("list_units", {})
      .catch((cause: unknown) => cause);
    await received;
    close
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure);
    endpoint.restart();
    const failure = await endpoint.connection
      .call("open_project", {})
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(JebMcpCleanupFailure);
    if (!(failure instanceof JebMcpCleanupFailure)) throw failure;
    expect(failure.primaryFailure).toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Session not found"),
      }),
    });
    expect(failure.cleanupFailure.cause).toMatchObject({
      errors: [cleanupFailure],
    });
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toEqual([
      `${endpoint.url} (JEB MCP client)`,
    ]);
    expect(await overlapping).toBe(failure);
    await expect(
      endpoint.connection.call("list_units", {}),
    ).rejects.toMatchObject({ cleanupIncomplete: true });
    expect(endpoint.handshakes()).toBe(1);
    expect(endpoint.calls).toEqual([
      "get_client_information",
      "list_units",
      "open_project",
    ]);
    await expect(
      endpoint.connection.call("list_units", {}),
    ).resolves.toMatchObject({
      success: true,
      generation: 2,
    });
    expect(endpoint.handshakes()).toBe(2);
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupResources).toEqual([]);
  } finally {
    close.mockRestore();
    await endpoint.close();
  }
});

it.each([false, true])(
  "refreshes engine provenance after reconnect (initial version omitted=%s)",
  async (omitInitialVersion) => {
    const endpoint = await startEndpoint(200, undefined, omitInitialVersion);
    const provider = new JebProvider({
      environment: { REA_JEB_MCP_URL: endpoint.url.toString() },
      connectionFactory: () => endpoint.connection,
    });
    const request = {
      operation: "list_jeb_units",
      input: { count: 10, index: 0 },
    } as const;
    try {
      const initial = await provider.execute(request);
      if (!initial.ok) throw initial.error;
      expect(initial.value).toMatchObject({
        provider: { version: omitInitialVersion ? null : "fixture-1" },
        result: {
          engine: {
            version: omitInitialVersion ? null : "fixture-1",
            gui_client: false,
          },
        },
      });
      const cachedInitial = await provider.execute(request);
      if (!cachedInitial.ok) throw cachedInitial.error;
      expect(
        endpoint.calls.filter((name) => name === "get_client_information"),
      ).toHaveLength(1);
      const received = endpoint.holdNextRequest();
      const overlapping = provider.execute(request);
      await received;
      endpoint.restart();
      const failed = await provider.execute(request);
      for (const result of [failed, await overlapping]) {
        if (result.ok) throw new Error("Expected session failure");
        expect(result.error).toMatchObject({
          _tag: "AnalysisCapabilityUnavailableError",
        });
        expect(result.error.message).toContain("Session not found");
      }
      const recovered = await provider.execute(request);
      if (!recovered.ok) throw recovered.error;
      expect(recovered.value).toMatchObject({
        provider: { version: "fixture-2" },
        result: { engine: { version: "fixture-2", gui_client: true } },
      });
      const cached = await provider.execute(request);
      if (!cached.ok) throw cached.error;
      expect(
        endpoint.calls.filter((name) => name === "get_client_information"),
      ).toHaveLength(2);
    } finally {
      await endpoint.close();
    }
  },
);

it("shares a pending invalidation with a new request until owned cleanup completes", async () => {
  const endpoint = await startEndpoint();
  const nativeClose = Client.prototype.close;
  let entered!: () => void;
  let release!: () => void;
  const closing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = vi.spyOn(Client.prototype, "close");
  try {
    await endpoint.connection.call("get_client_information", {});
    close.mockImplementationOnce(async function (this: Client) {
      entered();
      await gate;
      await nativeClose.call(this);
    });
    endpoint.restart();
    const failed = endpoint.connection
      .call("open_project", {})
      .catch((cause: unknown) => cause);
    await closing;
    const overlapping = endpoint.connection
      .call("list_units", {})
      .catch((cause: unknown) => cause);
    release();
    const failure = await failed;
    expect(failure).toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Session not found"),
      }),
    });
    expect(await overlapping).toBe(failure);
    expect(endpoint.handshakes()).toBe(1);
    expect(endpoint.calls).toEqual(["get_client_information", "open_project"]);
    await expect(
      endpoint.connection.call("list_units", {}),
    ).resolves.toMatchObject({ success: true, generation: 2 });
    expect(endpoint.handshakes()).toBe(2);
  } finally {
    release();
    close.mockRestore();
    await endpoint.close();
  }
});
