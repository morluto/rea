import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

describe("reconstruction obligation ledger MCP parity", () => {
  it("builds an Evidence-backed page and exposes the retained resource", async () => {
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({ name: "obligation-ledger-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "build_reconstruction_obligation_ledger",
        arguments: {
          evidence_bundle: createEvidenceBundle([]),
          reviewed_obligations: [],
          manifest: {
            schema_version: 1,
            bindings: [],
            contradictions: [],
          },
          limits: { max_obligations: 100 },
          page: { offset: 0, limit: 50 },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
        evidence_uri: expect.stringMatching(
          /^rea:\/\/evidence\/ev_[a-f0-9]{64}$/u,
        ),
        result: {
          schema: "ReconstructionObligationLedger",
          status: "unknown",
          summary: { total: 0 },
        },
      });
      const evidence = result.structuredContent;
      if (
        evidence === undefined ||
        evidence === null ||
        typeof evidence !== "object" ||
        !("evidence_id" in evidence) ||
        typeof evidence.evidence_id !== "string"
      )
        throw new TypeError("Missing obligation ledger Evidence ID");
      const resource = await client.readResource({
        uri: `rea://evidence/${evidence.evidence_id}/reconstruction-obligation-ledger`,
      });
      expect(resource.contents[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining(
            '"schema": "ReconstructionObligationLedger"',
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
