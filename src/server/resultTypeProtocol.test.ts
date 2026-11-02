import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";

/**
 * Protocol revision 2026-07-28 made `resultType` a REQUIRED member of every
 * result: a client on that revision discards a `tools/call` result without
 * it ("missing required resultType"), which is how calls backgrounded by a
 * client after 120 s lose both their payload and REA's structured error.
 * The triggering delay is irrelevant at the protocol layer, so these tests
 * exercise the negotiated revision directly over InMemoryTransport.
 *
 * `serveStdio` (the SDK serving entry REA runs under) marks the connected
 * instance modern before traffic flows; the tests reproduce that marking
 * the same way to reach REA's own outbound seam.
 */
const markModernEra = (server: McpServer): void => {
  const inner = (server as unknown as { server: object }).server as Record<
    string,
    unknown
  >;
  inner["_negotiatedProtocolVersion"] = "2026-07-28";
};

describe("tools/call results carry resultType on revision 2026-07-28", () => {
  const collectResults = (
    clientTransport: ReturnType<typeof InMemoryTransport.createLinkedPair>[0],
  ): Record<string, unknown>[] => {
    const results: Record<string, unknown>[] = [];
    const original = clientTransport.onmessage;
    clientTransport.onmessage = (message: JSONRPCMessage) => {
      const record = message as { result?: unknown };
      if (
        record &&
        typeof record === "object" &&
        record.result !== undefined &&
        typeof record.result === "object" &&
        record.result !== null &&
        "content" in record.result
      )
        results.push(record.result as Record<string, unknown>);
      original?.(message);
    };
    return results;
  };

  it("serves server/discover at 2026-07-28 and stamps success and error results", async () => {
    const server = new EvidenceMcpServer(
      { name: "result-type-success", version: "1" },
      { capabilities: {} },
      undefined,
      new ToolResultDelivery(4096),
    );
    server.registerTool(
      "echo",
      { inputSchema: z.strictObject({}) },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const client = new Client(
      { name: "modern-client", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const results = collectResults(clientTransport);
    try {
      markModernEra(server);
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const ok = await client.callTool({ name: "echo", arguments: {} });
      expect(ok.isError).toBeFalsy();

      const bad = await client.callTool({
        name: "echo",
        arguments: { nope: true },
      });
      expect(bad.isError).toBe(true);

      expect(results.length).toBeGreaterThanOrEqual(2);
      for (const result of results) {
        expect(result).toHaveProperty("resultType", "complete");
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("keeps resultType when oversized error recovery replaces the result", async () => {
    const server = new EvidenceMcpServer(
      { name: "result-type-recovery", version: "1" },
      { capabilities: {} },
      undefined,
      new ToolResultDelivery(4096),
    );
    server.registerTool(
      "procedure_pseudo_code",
      { inputSchema: z.strictObject({ required: z.string() }) },
      async () => ({ content: [{ type: "text", text: "valid call" }] }),
    );
    const client = new Client(
      { name: "modern-client", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const results = collectResults(clientTransport);
    try {
      markModernEra(server);
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const oversizedKey = `unexpected_${"x".repeat(6000)}`;
      const oversized = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { required: "present", [oversizedKey]: true },
      });
      expect(oversized.isError).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(4096);

      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        expect(result).toHaveProperty("resultType", "complete");
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
