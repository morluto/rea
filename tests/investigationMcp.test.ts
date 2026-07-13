import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BinarySession } from "../src/application/BinarySession.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../src/contracts/functionComparisonExample.js";
import { INVESTIGATION_EXAMPLES } from "../src/contracts/investigationExamples.js";
import {
  FUNCTION_COMPARISON_EVIDENCE,
  PROCESS_CAPTURE_RECONSTRUCTION,
  PROCESS_CAPTURE_REFERENCE,
  PROCESS_COMPARISON_EVIDENCE,
} from "../src/contracts/investigationExamples.js";
import { createEvidence, parseEvidence } from "../src/domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../src/domain/jsonValue.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";

describe("investigation MCP workflows", () => {
  it("aggregates comparison Evidence and records an approved runtime gap", async () => {
    const { session, server, client } = await connected();
    const comparison =
      INVESTIGATION_EXAMPLES.find_changed_behavior.comparisons[0];
    if (comparison === undefined) throw new Error("missing comparison fixture");
    for (const evidence of [
      FUNCTION_COMPARISON_EXAMPLE.left,
      FUNCTION_COMPARISON_EXAMPLE.right,
      comparison,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    try {
      const response = await client.callTool({
        name: "find_changed_behavior",
        arguments: {
          comparisons: [comparison],
          unknown_registry_approved: true,
        },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const evidence = parseEvidence(
        z.object({ result: z.unknown() }).parse(response.structuredContent)
          .result,
      );
      expect(evidence).toMatchObject({
        provider: { id: "rea-changed-behavior" },
        normalized_result: { behavior_status: "unknown" },
      });
      expect(
        session.listUnknowns({ domain: "changed-behavior" }),
      ).toMatchObject([
        {
          question:
            "Did both versions behave the same under a complete controlled replay?",
        },
      ]);
    } finally {
      await close(session, server, client);
    }
  });

  it("builds a zero-hop exact-address path with dossier citations", async () => {
    const { session, server, client } = await connected();
    expect(session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.left).ok).toBe(
      true,
    );
    try {
      const response = await client.callTool({
        name: "build_call_path",
        arguments: INVESTIGATION_EXAMPLES.build_call_path,
      });
      expect(response.isError).not.toBe(true);
      const evidence = parseEvidence(
        z.object({ result: z.unknown() }).parse(response.structuredContent)
          .result,
      );
      expect(evidence).toMatchObject({
        provider: { id: "rea-call-path" },
        normalized_result: {
          status: "found",
          shortest_hops: 0,
          paths: { total: 1 },
        },
        evidence_links: [FUNCTION_COMPARISON_EXAMPLE.left.evidence_id],
      });
    } finally {
      await close(session, server, client);
    }
  });

  it("records a safe unresolved call-path question", async () => {
    const { session, server, client } = await connected();
    const base = FUNCTION_COMPARISON_EXAMPLE.left;
    if (base.subject === null) throw new Error("missing dossier subject");
    const dossier = createEvidence(
      {
        path: base.subject.local_path,
        sha256: base.subject.digest.sha256,
        format: base.subject.format,
        ...(base.subject.architecture === null
          ? {}
          : { architecture: base.subject.architecture }),
      },
      base.provider,
      {
        predicateType: base.predicate_type,
        operation: base.operation,
        parameters: base.parameters,
        result: jsonValueSchema.parse({
          ...jsonObjectSchema.parse(base.normalized_result),
          callees: {
            items: [{ address: "0x2000", name: "next" }],
            total: 1,
            returned: 1,
            truncated: false,
            next_offset: null,
          },
        }),
        rawResult: base.raw_result,
        confidence: base.confidence,
        authority: base.authority,
        limitations: base.limitations,
        locations: base.locations,
        evidenceLinks: base.evidence_links,
      },
    );
    expect(session.recordEvidence(dossier).ok).toBe(true);
    try {
      const response = await client.callTool({
        name: "build_call_path",
        arguments: {
          ...INVESTIGATION_EXAMPLES.build_call_path,
          functions: [dossier],
          start: { address: "0x1000" },
          goal: { address: "0x3000" },
          unknown_registry_approved: true,
        },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(session.listUnknowns({ domain: "call-path" })).toMatchObject([
        {
          question:
            "Can the requested call path be established from complete analysis?",
        },
      ]);
    } finally {
      await close(session, server, client);
    }
  });

  it("records an explicit non-causal static/runtime hypothesis", async () => {
    const { session, server, client } = await connected();
    for (const evidence of [
      FUNCTION_COMPARISON_EXAMPLE.left,
      FUNCTION_COMPARISON_EXAMPLE.right,
      FUNCTION_COMPARISON_EVIDENCE,
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    try {
      const response = await client.callTool({
        name: "correlate_static_and_runtime",
        arguments: INVESTIGATION_EXAMPLES.correlate_static_and_runtime,
      });
      expect(response.isError).not.toBe(true);
      const evidence = parseEvidence(
        z.object({ result: z.unknown() }).parse(response.structuredContent)
          .result,
      );
      expect(evidence).toMatchObject({
        provider: { id: "rea-static-runtime-correlation" },
        confidence: "inferred",
        normalized_result: {
          status: "correlated",
          summary: { hypotheses: 1 },
        },
      });
    } finally {
      await close(session, server, client);
    }
  });

  it("records a safe unresolved static/runtime question", async () => {
    const { session, server, client } = await connected();
    for (const evidence of [
      FUNCTION_COMPARISON_EXAMPLE.left,
      FUNCTION_COMPARISON_EXAMPLE.right,
      FUNCTION_COMPARISON_EVIDENCE,
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    const mapping =
      INVESTIGATION_EXAMPLES.correlate_static_and_runtime.mappings[0];
    if (mapping === undefined) throw new Error("missing correlation fixture");
    try {
      const response = await client.callTool({
        name: "correlate_static_and_runtime",
        arguments: {
          ...INVESTIGATION_EXAMPLES.correlate_static_and_runtime,
          mappings: [
            {
              ...mapping,
              static: {
                ...mapping.static,
                selector: { kind: "function", dimension: "assembly" },
              },
            },
          ],
          unknown_registry_approved: true,
        },
      });
      expect(response.isError).not.toBe(true);
      expect(
        session.listUnknowns({ domain: "static-runtime-correlation" }),
      ).toMatchObject([
        {
          question:
            "Does runtime behavior match the available static analysis?",
        },
      ]);
    } finally {
      await close(session, server, client);
    }
  });

  it("passes only the finite declared reconstruction specification", async () => {
    const { session, server, client } = await connected();
    for (const evidence of [
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    try {
      const response = await client.callTool({
        name: "verify_reconstruction",
        arguments: {
          ...INVESTIGATION_EXAMPLES.verify_reconstruction,
          unknown_registry_approved: true,
        },
      });
      expect(response.isError).not.toBe(true);
      const evidence = parseEvidence(
        z.object({ result: z.unknown() }).parse(response.structuredContent)
          .result,
      );
      expect(evidence).toMatchObject({
        provider: { id: "rea-reconstruction-verifier" },
        normalized_result: { status: "pass", summary: { passed: 1 } },
      });
      expect(evidence.limitations).toContain(
        "Pass means every declared claim passed; it does not establish global implementation equivalence.",
      );
    } finally {
      await close(session, server, client);
    }
  });

  it("cannot omit a session-owned active unknown from reconstruction input", async () => {
    const { session, server, client } = await connected();
    for (const evidence of [
      PROCESS_CAPTURE_REFERENCE,
      PROCESS_CAPTURE_RECONSTRUCTION,
      PROCESS_COMPARISON_EVIDENCE,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    expect(
      session.recordUnknown({
        approved: true,
        question: "Was terminal equivalence reproduced independently?",
        severity: "high",
        domain: "reconstruction-verification",
        supporting_evidence_ids: [PROCESS_COMPARISON_EVIDENCE.evidence_id],
        contradicting_evidence_ids: [],
        required_authority: "controlled-replay",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [
          {
            operation: "capture_process_scenario",
            rationale: "Repeat both sides under one controlled environment.",
          },
        ],
        relationships: [],
      }).ok,
    ).toBe(true);
    try {
      const response = await client.callTool({
        name: "verify_reconstruction",
        arguments: {
          ...INVESTIGATION_EXAMPLES.verify_reconstruction,
          unknown_registry_approved: true,
        },
      });
      expect(response.isError).not.toBe(true);
      const evidence = parseEvidence(
        z.object({ result: z.unknown() }).parse(response.structuredContent)
          .result,
      );
      expect(evidence.normalized_result).toMatchObject({
        status: "unknown",
        summary: { unknown: 1 },
      });
      expect(
        session.listUnknowns({ domain: "reconstruction-verification" }),
      ).toContainEqual(
        expect.objectContaining({
          question: "Does the reconstruction satisfy every declared claim?",
        }),
      );
    } finally {
      await close(session, server, client);
    }
  });
});

const connected = async () => {
  const session = new BinarySession(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));
  const server = createServer(session, session);
  const client = new Client({ name: "investigation-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { session, server, client };
};

const close = async (
  session: BinarySession,
  server: Awaited<ReturnType<typeof createServer>>,
  client: Client,
) => {
  await Promise.allSettled([client.close(), server.close(), session.close()]);
};
