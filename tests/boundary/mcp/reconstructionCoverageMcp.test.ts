import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { completeReconstructionCoverageData } from "../../../src/domain/reconstructionCoverage.fixture.js";
import { createReconstructionCoverageData } from "../../../src/domain/reconstructionCoverage.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

describe("reconstruction coverage MCP", () => {
  it("evaluates inline fail-closed coverage without session retention", async () => {
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "coverage-mcp-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const boundaryId = "replacement.cli";
      const result = await client.callTool({
        name: "evaluate_reconstruction_coverage",
        arguments: {
          coverage: currentFixtureCoverage(boundaryId),
          boundary_id: boundaryId,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "ready",
        boundary_id: boundaryId,
        summary: { reasons: 0 },
      });
      const unknown = await client.callTool({
        name: "evaluate_reconstruction_coverage",
        arguments: {
          coverage: currentFixtureCoverage(boundaryId),
          boundary_id: "replacement.missing",
        },
      });
      expect(unknown.isError).toBe(true);
      expect(parseMcpToolError(unknown)).toMatchObject({
        error: {
          code: "invalid_request",
          details: {
            issues: [
              {
                path: [],
                reason: "invalid_value",
                message: "Unknown reconstruction boundary: replacement.missing",
              },
            ],
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});

const currentFixtureCoverage = (boundaryId: string) => {
  const coverage = completeReconstructionCoverageData();
  return createReconstructionCoverageData({
    ...coverage,
    boundaries: coverage.boundaries.map((boundary) => ({
      ...boundary,
      boundary_id: boundaryId,
    })),
    verifier_results: coverage.verifier_results.map((result) => ({
      ...result,
      observed_at: new Date().toISOString(),
    })),
  });
};
