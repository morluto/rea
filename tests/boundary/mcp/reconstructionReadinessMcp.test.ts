import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { RECONSTRUCTION_READINESS_EXAMPLE } from "../../../src/contracts/reconstructionReadinessExample.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

describe("reconstruction readiness MCP parity", () => {
  it("returns a passing compact result and retains the full report resource", async () => {
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({ name: "readiness-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "evaluate_reconstruction_readiness",
        arguments: RECONSTRUCTION_READINESS_EXAMPLE,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
        result: {
          schema: "ReconstructionReadinessReport",
          status: "pass",
          summary: { passed_required_stages: 9 },
          report_resource_uri: expect.stringMatching(
            /^rea:\/\/evidence\/ev_[a-f0-9]{64}\/reconstruction-readiness-report$/u,
          ),
        },
      });
      expect(result.structuredContent).not.toHaveProperty("result.snapshot");
      expect(result.structuredContent).not.toHaveProperty("result.stages");
      const content = result.structuredContent;
      if (
        content === undefined ||
        content === null ||
        typeof content !== "object" ||
        !("evidence_id" in content) ||
        typeof content.evidence_id !== "string"
      )
        throw new TypeError("Missing readiness Evidence ID");
      const resource = await client.readResource({
        uri: `rea://evidence/${content.evidence_id}/reconstruction-readiness-report`,
      });
      expect(resource.contents[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining(
            '"schema": "ReconstructionReadinessReport"',
          ),
        }),
      );
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
