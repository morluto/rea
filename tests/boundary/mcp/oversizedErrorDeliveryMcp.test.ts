import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";

import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import type { EvidenceWriter } from "../../../src/application/investigation/InvestigationRecordPort.js";
import { EvidenceIntegrityError } from "../../../src/domain/evidenceErrors.js";
import { err } from "../../../src/domain/result.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";

const delivery = new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);

const oversizedFailure = () =>
  delivery.toErrorToolResult(
    new AnalysisInputError("procedure_address", undefined, [
      {
        path: ["procedure"],
        reason: "invalid_value",
        message: `Unknown Ghidra procedure name or address: REA_MISSING_${"x".repeat(Math.ceil(STDIO_DEFAULT_MAX_BUFFER_SIZE / 2) + 64 * 1024)}`,
      },
    ]),
  );

const exerciseDeliveryFailure = async (
  recordEvidence: EvidenceWriter["recordEvidence"] | undefined,
) => {
  const server = new EvidenceMcpServer(
    { name: "oversized-error-test", version: "1" },
    { capabilities: {} },
    recordEvidence,
    delivery,
  );
  server.registerTool("large_failure", { inputSchema: {} }, async () =>
    oversizedFailure(),
  );
  server.registerTool(
    "healthy",
    { inputSchema: {} },
    async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "still connected" }],
    }),
  );
  const client = new Client({ name: "oversized-error-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const failure = await client.callTool({
      name: "large_failure",
      arguments: {},
    });
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toMatchObject({
      error: {
        code: "resource_constraint",
        details: {
          reported_limits: {
            original_error_code: "invalid_request",
          },
        },
      },
    });
    const reportedLimits = z
      .object({
        error: z.object({
          code: z.literal("resource_constraint"),
          details: z.object({
            reported_limits: z.record(z.string(), z.unknown()),
          }),
        }),
      })
      .parse(failure.structuredContent).error.details.reported_limits;
    expect(failure.structuredContent).toMatchObject({
      error: {
        details: {
          reported_limits: {
            boundary: "mcp-response",
          },
        },
      },
    });
    expect(reportedLimits).not.toHaveProperty("evidence_reference");
    expect(reportedLimits.retention).toBe(
      recordEvidence === undefined ? "unavailable" : "failed",
    );
    if (recordEvidence !== undefined)
      expect(reportedLimits.retention_error).toMatchObject({
        code: "evidence_integrity_mismatch",
      });
    expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );

    const healthy = await client.callTool({ name: "healthy", arguments: {} });
    expect(healthy.content).toContainEqual({
      type: "text",
      text: "still connected",
    });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
};

it("keeps the SDK connection usable when oversized-error retention is unavailable or fails", async () => {
  await exerciseDeliveryFailure(undefined);
  await exerciseDeliveryFailure(() =>
    err(
      new EvidenceIntegrityError("fixture ledger rejected the Evidence record"),
    ),
  );
});
