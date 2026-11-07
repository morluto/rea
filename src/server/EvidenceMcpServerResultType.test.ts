import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCResultResponse,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { InvestigationRecords } from "../application/investigation/InvestigationRecords.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { ensureToolResultType } from "./EvidenceMcpServerCore.js";
import { createToolResultDelivery } from "./toolResult.js";

/**
 * Regression test for morluto/rea #5273.
 *
 * A client background task re-validates a completed long call with the
 * strict 2026-07-28 rules, which require resultType. Backgrounding itself
 * is client-side, so this test cannot wait 120 s or reproduce Claude
 * Code's background task: instead it covers the server-side invariant
 * that test can check — the raw wire result of a slow call, in success,
 * error, and thrown-handler shapes, carries resultType "complete" under
 * both negotiated eras. Before the transport fix, the 2025-era wire
 * results carried no resultType at all.
 */
const collectToolResults = async (revision: string) => {
  const records = new InvestigationRecords();
  const delivery = createToolResultDelivery(16384);
  const server = new EvidenceMcpServer(
    { name: "result-type-test", version: "1" },
    { capabilities: {} },
    (evidence) => records.recordEvidence(evidence),
    delivery,
  );
  // A slow handler stands in for a long-running provider call: the wire
  // shape must not depend on how long the handler took.
  server.registerTool(
    "slow_ok",
    { inputSchema: z.strictObject({}) },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
  server.registerTool(
    "slow_err",
    { inputSchema: z.strictObject({}) },
    async () => ({
      content: [{ type: "text", text: "provider_timeout" }],
      isError: true,
    }),
  );
  server.registerTool(
    "slow_throw",
    { inputSchema: z.strictObject({}) },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error("boom");
    },
  );
  const client = new Client(
    { name: "result-type-client", version: "1" },
    revision === "2026-07-28"
      ? { versionNegotiation: { mode: { pin: revision } } }
      : { supportedProtocolVersions: [revision] },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const replies: JSONRPCResultResponse[] = [];
  const receive = clientTransport.onmessage;
  clientTransport.onmessage = (message) => {
    if (isJSONRPCResultResponse(message)) replies.push(message);
    receive?.(message);
  };
  const serving = serveStdio(() => server, { transport: serverTransport });
  try {
    await client.connect(clientTransport);
    expect(client.getNegotiatedProtocolVersion()).toBe(revision);
    const ok = await client.callTool({ name: "slow_ok", arguments: {} });
    expect(ok.content).toContainEqual({ type: "text", text: "ok" });
    const err = await client.callTool({ name: "slow_err", arguments: {} });
    expect(err.isError).toBe(true);
    // A thrown handler is delivered as an isError result, not a rejection.
    const thrown = await client.callTool({
      name: "slow_throw",
      arguments: {},
    });
    expect(thrown.isError).toBe(true);
    // tools/call results carry a content array; the initialize reply does not.
    return replies.filter(
      (reply) =>
        typeof reply.result === "object" &&
        reply.result !== null &&
        Array.isArray((reply.result as { content?: unknown }).content),
    );
  } finally {
    await Promise.all([client.close(), serving.close()]);
  }
};

describe("ensureToolResultType (direct helper coverage)", () => {
  // A tools/call wire result carrying a non-complete resultType cannot be
  // produced through the public server API: the SDK turns a handler's
  // input_required signal into multi-round-trip requests instead of a
  // wire result (verified by experiment: no input_required wire reply is
  // ever sent, the client instead exhausts its round-trip limit). So the
  // never-overwrite rule is covered by calling the helper directly.
  const toolResult = (result: Record<string, unknown>): JSONRPCMessage => ({
    jsonrpc: "2.0",
    id: 1,
    result,
  });

  it("fills in complete when resultType is absent, without mutating the input", () => {
    const input = toolResult({
      content: [{ type: "text", text: "ok" }],
    });
    const filled = ensureToolResultType(input);
    expect((filled as JSONRPCResultResponse).result).toMatchObject({
      resultType: "complete",
    });
    expect(input).not.toBe(filled);
    expect((input as JSONRPCResultResponse).result).not.toHaveProperty(
      "resultType",
    );
  });

  it("leaves an existing non-complete resultType unchanged", () => {
    const input = toolResult({
      content: [{ type: "text", text: "need more" }],
      resultType: "input_required",
      requestState: "test-state",
    });
    expect(ensureToolResultType(input)).toBe(input);
    expect(
      (ensureToolResultType(input) as JSONRPCResultResponse).result,
    ).toMatchObject({ resultType: "input_required" });
  });

  it("leaves an existing complete resultType unchanged", () => {
    const input = toolResult({
      content: [{ type: "text", text: "ok" }],
      resultType: "complete",
    });
    expect(ensureToolResultType(input)).toBe(input);
  });

  it("leaves non-tools/call messages unchanged", () => {
    const errorResponse: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "boom" },
    };
    expect(ensureToolResultType(errorResponse)).toBe(errorResponse);
    const nonToolResult = toolResult({ protocolVersion: "2025-11-25" });
    expect(ensureToolResultType(nonToolResult)).toBe(nonToolResult);
  });
});

describe("tools/call resultType on the wire", () => {
  it.each(["2025-11-25", "2026-07-28"])(
    "every slow success, error, and thrown result carries resultType complete under %s",
    async (revision) => {
      const results = await collectToolResults(revision);
      expect(results).toHaveLength(3);
      for (const reply of results) {
        expect((reply.result as { resultType?: unknown }).resultType).toBe(
          "complete",
        );
      }
      expect(
        results.map((reply) => (reply.result as { isError?: boolean }).isError),
      ).toEqual([undefined, true, true]);
    },
  );
});
