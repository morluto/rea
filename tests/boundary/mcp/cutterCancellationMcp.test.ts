import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { CutterBridgeService } from "../../../src/cutter/CutterBridgeService.js";
import { registerCutterTools } from "../../../src/server/registerCutterTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { silentLogger } from "../../../src/logger.js";

it("propagates MCP cancellation into an active Cutter command and reports uncertain completion", async () => {
  let markDispatched: (() => void) | undefined;
  let observedAbort = false;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  const service = new CutterBridgeService({
    listSessions: async () => ({
      sessions: [],
      bridge_directory: "/private/bridge",
      discovery_status: "no_live_bridge_found",
      bridge_directory_security: "private_verified",
    }),
    execute: async ({ signal }) => {
      markDispatched?.();
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true },
        );
      });
      return {
        output: null,
        currentFile: null,
        documentGeneration: 1,
        identityStatus: "partial" as const,
        cutterVersion: "Cutter fixture version",
        executionState: "unknown" as const,
        error: "transport-response-missing",
        message: "The command may have completed; do not retry automatically",
        outputTruncated: false,
      };
    },
  });
  const server = new McpServer({ name: "cutter-cancellation", version: "1" });
  registerCutterTools(
    server,
    service,
    silentLogger,
    createToolResultDelivery(undefined),
  );
  const client = new Client({ name: "cutter-cancellation", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const controller = new AbortController();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const request = client.callTool(
      {
        name: "cutter_command",
        arguments: {
          session_id: "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a",
          expected_generation: 1,
          command: "Ps /tmp/possibly-saved.rzdb",
          json: false,
        },
      },
      { signal: controller.signal },
    );
    await dispatched;
    controller.abort();
    await expect(request).rejects.toThrow(/abort/iu);
    await expect.poll(() => observedAbort).toBe(true);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});
