import { createVerifierHttpServer } from "../../../scripts/lib/verifier-http-server.mjs";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { expect, it, vi } from "vitest";
import { z } from "zod";

import { createStreamableHttpJebMcpConnection } from "../../../src/jeb/JebMcpConnection.js";
import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { testWaitDeadline } from "../../support/testWait.js";

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

const createCatalogServer = async () => {
  const controls = {
    includeOpen: true,
    repeatedCursor: false,
    continuedPages: 0,
    initializeElapsedMs: 0,
    pageElapsedMs: 0,
    pageCount: 0,
  };
  const cursors: (string | undefined)[] = [];
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (request.method !== "POST") {
      request.resume();
      response.writeHead(request.method === "DELETE" ? 200 : 405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = requestSchema.parse(JSON.parse(body));
    if (message.id === undefined) {
      if (
        message.method !== "notifications/initialized" &&
        message.method !== "notifications/cancelled"
      )
        throw new Error(`Unexpected JEB notification: ${message.method}`);
      response.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (message.method === "initialize") {
      if (controls.initializeElapsedMs > 0)
        vi.advanceTimersByTime(controls.initializeElapsedMs);
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "jeb-catalog-fixture", version: "1" },
      };
    } else if (message.method === "tools/list") {
      const cursor = message.params?.cursor;
      controls.pageCount += 1;
      cursors.push(cursor);
      if (controls.pageElapsedMs > 0)
        vi.advanceTimersByTime(controls.pageElapsedMs);
      const names =
        cursor === undefined
          ? ["get_client_information"]
          : controls.includeOpen
            ? ["open_project"]
            : ["list_units"];
      let nextCursor: string | undefined;
      if (controls.continuedPages > 0) {
        controls.continuedPages -= 1;
        if (controls.continuedPages > 0)
          nextCursor = `fresh-page-${controls.pageCount}`;
      } else if (cursor === undefined || controls.repeatedCursor) {
        nextCursor = "second-page";
      }
      result = {
        tools: [...names, "unused_extension"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    } else {
      throw new Error(`Unexpected JEB request: ${message.method}`);
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  };
  const { server, close } = createVerifierHttpServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected an ephemeral TCP listener");

  return {
    controls,
    cursors,
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    close,
  };
};

it("uses the selected discovery budget across handshake and catalog pages", async () => {
  const { controls, cursors, endpoint, close } = await createCatalogServer();
  const discoveryTimeoutMs = 220_000;
  const url = new URL(endpoint);
  const connection = createStreamableHttpJebMcpConnection(url, {
    discoveryTimeoutMs,
  });
  const acquiring = createStreamableHttpJebMcpConnection(url, {
    discoveryTimeoutMs,
  });
  const initialTools = ["get_client_information", "open_project"];
  const refreshedTools = ["get_client_information", "list_units"];
  await withVerifierCleanup(async () => {
    const signal = AbortSignal.timeout(testWaitDeadline());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    // Each reply arrives beyond the SDK default, within one shared limit.
    controls.initializeElapsedMs = 65_000;
    controls.pageElapsedMs = 65_000;
    expect(await connection.listTools(signal)).toEqual(initialTools);
    controls.initializeElapsedMs = 0;
    controls.pageElapsedMs = 0;
    controls.includeOpen = false;
    expect(await connection.listTools(signal)).toEqual(refreshedTools);
    expect(cursors).toEqual([
      undefined,
      "second-page",
      undefined,
      "second-page",
    ]);

    for (const owner of [connection, acquiring]) {
      // A fifth page would be available if the deadline were renewed per page.
      controls.continuedPages = 5;
      controls.pageElapsedMs = 55_000;
      const before = controls.pageCount;
      await expect(owner.listTools(signal)).rejects.toBeInstanceOf(
        AnalysisTimeoutError,
      );
      expect(controls.pageCount - before).toBe(4);
      controls.continuedPages = 0;
      controls.pageElapsedMs = 0;
      expect(await owner.listTools(signal)).toEqual(refreshedTools);
    }

    controls.repeatedCursor = true;
    await expect(connection.listTools(signal)).rejects.toThrow(
      "repeated a tool catalog cursor",
    );
    controls.repeatedCursor = false;
    expect(await connection.listTools(signal)).toEqual(refreshedTools);
  }, [
    () => vi.useRealTimers(),
    () => connection.close(),
    () => acquiring.close(),
    close,
  ]);
});
