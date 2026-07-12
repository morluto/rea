import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BinarySession } from "../src/application/BinarySession.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../src/contracts/functionComparisonExample.js";
import { parseEvidence } from "../src/domain/evidence.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";

describe("function comparison MCP integration", () => {
  it("records linked comparison Evidence and an approved residual unknown", async () => {
    const session = new BinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    expect(session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.left).ok).toBe(
      true,
    );
    expect(session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.right).ok).toBe(
      true,
    );
    const server = createServer(session, session);
    const client = new Client({
      name: "function-comparison-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_functions",
        arguments: {
          left: FUNCTION_COMPARISON_EXAMPLE.left,
          right: FUNCTION_COMPARISON_EXAMPLE.right,
          unknown_registry_approved: true,
        },
      });
      expect(result.isError).not.toBe(true);
      const evidence = parseEvidence(
        z.object({ result: z.unknown() }).parse(result.structuredContent)
          .result,
      );
      expect(evidence).toMatchObject({
        provider: { id: "rea-function-comparison" },
        evidence_links: [
          FUNCTION_COMPARISON_EXAMPLE.left.evidence_id,
          FUNCTION_COMPARISON_EXAMPLE.right.evidence_id,
        ],
      });
      const unknowns = await client.callTool({
        name: "list_unknowns",
        arguments: { domain: "function-comparison" },
      });
      expect(unknowns.structuredContent).toMatchObject({
        result: [expect.objectContaining({ domain: "function-comparison" })],
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });

  it("rejects dangling Evidence links before recording output", async () => {
    const session = new BinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({ name: "function-link-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_functions",
        arguments: {
          left: FUNCTION_COMPARISON_EXAMPLE.left,
          right: FUNCTION_COMPARISON_EXAMPLE.right,
        },
      });
      expect(result.isError).toBe(true);
      expect(session.exportEvidenceBundle().records).toEqual([]);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });
});
