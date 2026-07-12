import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BinarySession } from "../src/application/BinarySession.js";
import { createEvidence, parseEvidence } from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import { createResidualUnknown } from "../src/domain/residualUnknown.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";

const sourceEvidence = (label: string) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "observe",
      parameters: { label },
      result: { label },
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );

describe("bundle comparison MCP integration", () => {
  it("rejects altered records that reuse session Evidence IDs", async () => {
    const session = new BinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const leftRecord = sourceEvidence("left-authority");
    const rightRecord = sourceEvidence("right-authority");
    session.recordEvidence(leftRecord);
    session.recordEvidence(rightRecord);
    const altered = {
      ...leftRecord,
      limitations: ["caller altered this record"],
    };
    const server = createServer(session, session);
    const client = new Client({ name: "bundle-authority-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_bundles",
        arguments: {
          left: createEvidenceBundle([altered]),
          right: createEvidenceBundle([rightRecord]),
        },
      });
      expect(result.isError).toBe(true);
      expect(session.exportEvidenceBundle().records).toHaveLength(2);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });

  it("rejects unknown histories that are not owned by the session", async () => {
    const session = new BinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const leftRecord = sourceEvidence("left-unowned-unknown");
    const rightRecord = sourceEvidence("right-unowned-unknown");
    expect(session.recordEvidence(leftRecord).ok).toBe(true);
    expect(session.recordEvidence(rightRecord).ok).toBe(true);
    const unknown = createResidualUnknown(
      {
        approved: true,
        question: "Unowned history?",
        severity: "high",
        domain: "bundle-comparison-test",
        supporting_evidence_ids: [leftRecord.evidence_id],
        contradicting_evidence_ids: [],
        required_authority: "shipped-artifact",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
      },
      leftRecord.evidence_id,
      null,
    );
    const server = createServer(session, session);
    const client = new Client({ name: "bundle-unknown-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_bundles",
        arguments: {
          left: createEvidenceBundle([leftRecord], [unknown]),
          right: createEvidenceBundle([rightRecord]),
        },
      });
      expect(result.isError).toBe(true);
      expect(session.exportEvidenceBundle()).toMatchObject({
        records: [leftRecord, rightRecord].sort((left, right) =>
          left.evidence_id.localeCompare(right.evidence_id),
        ),
        unknowns: [],
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });

  it("records a digest-anchored comparison linked to every source record", async () => {
    const session = new BinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const leftRecord = sourceEvidence("left");
    const rightRecord = sourceEvidence("right");
    expect(session.recordEvidence(leftRecord).ok).toBe(true);
    expect(session.recordEvidence(rightRecord).ok).toBe(true);
    const server = createServer(session, session);
    const client = new Client({ name: "bundle-comparison-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_bundles",
        arguments: {
          left: createEvidenceBundle([leftRecord]),
          right: createEvidenceBundle([rightRecord]),
          record_pairs: [
            {
              left_evidence_id: leftRecord.evidence_id,
              right_evidence_id: rightRecord.evidence_id,
            },
          ],
        },
      });
      expect(result.isError).not.toBe(true);
      const evidence = parseEvidence(
        z.object({ result: z.unknown() }).parse(result.structuredContent)
          .result,
      );
      expect(evidence).toMatchObject({
        provider: { id: "rea-bundle-comparison" },
        evidence_links: [
          leftRecord.evidence_id,
          rightRecord.evidence_id,
        ].sort(),
        normalized_result: { status: "changed" },
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });
});
