import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { INVESTIGATION_EXAMPLES } from "../../../src/contracts/investigationExamples.js";
import {
  FUNCTION_COMPARISON_EVIDENCE,
  PROCESS_CAPTURE_RECONSTRUCTION,
  PROCESS_CAPTURE_REFERENCE,
  PROCESS_COMPARISON_EVIDENCE,
} from "../../../src/contracts/investigationExamples.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
} from "../../../src/domain/jsonValue.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import type { RelationshipCoverage } from "../../../src/domain/relationshipCoverage.js";

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
      },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = inlineEvidence(response.structuredContent);
    expect(evidence).toMatchObject({
      provider: { id: "rea-changed-behavior" },
      normalized_result: { behavior_status: "unknown" },
    });
    expect(session.listUnknowns({ domain: "changed-behavior" })).toMatchObject([
      {
        question:
          "Did both versions behave the same under a complete controlled replay?",
      },
    ]);
  } finally {
    await close(session, server, client);
  }
}, 10_000);

it("builds exact-address paths with qualified callees and dossier citations", async () => {
  const { session, server, client } = await connected();
  const dossier = dossierWithCallees(["EXTERNAL:0x1000"]);
  expect(session.recordEvidence(dossier).ok).toBe(true);
  try {
    const response = await client.callTool({
      name: "build_call_path",
      arguments: {
        ...INVESTIGATION_EXAMPLES.build_call_path,
        functions: [dossier],
      },
    });
    expect(response.isError).not.toBe(true);
    const evidence = inlineEvidence(response.structuredContent);
    expect(evidence).toMatchObject({
      provider: { id: "rea-call-path" },
      normalized_result: {
        status: "found",
        shortest_hops: 0,
        paths: [expect.objectContaining({ hops: 0 })],
      },
      evidence_links: [dossier.evidence_id],
    });
    const externalPath = await client.callTool({
      name: "build_call_path",
      arguments: {
        functions: [dossier],
        start: { address: "0x1000" },
        goal: { address: "EXTERNAL:0X001000" },
      },
    });
    expect(externalPath.isError, JSON.stringify(externalPath)).not.toBe(true);
    expect(inlineEvidence(externalPath.structuredContent)).toMatchObject({
      normalized_result: {
        status: "found",
        shortest_hops: 1,
        paths: [
          {
            nodes: [
              { address: "0x1000", evidence_links: [dossier.evidence_id] },
              {
                address: "EXTERNAL:0x1000",
                evidence_links: [dossier.evidence_id],
              },
            ],
          },
        ],
      },
    });
  } finally {
    await close(session, server, client);
  }
});

const dossierWithCallees = (addresses: readonly string[]) => {
  const base = FUNCTION_COMPARISON_EXAMPLE.left;
  if (base.subject === null) throw new Error("missing dossier subject");
  return createEvidence(
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
        callees: addresses.map((address) => ({
          address,
          name: "next",
          classification: null,
          body: {
            available: false,
            reason: "The fixture has no callee body-extent observation.",
          },
        })),
      }),
      rawResult: base.raw_result,
      confidence: base.confidence,
      authority: base.authority,
      limitations: base.limitations,
      locations: base.locations,
      evidenceLinks: base.evidence_links,
    },
  );
};

it.each([
  {
    label: "complete",
    coverage: { status: "complete" } as RelationshipCoverage,
    providerLimitations: ["The provider version identity is unavailable."],
    dossierLimitations: ["The dossier has no native value-flow observation."],
    status: "not_found",
    exhaustive: true,
  },
  {
    label: "partial",
    coverage: {
      status: "partial",
      limitations: ["Callee output was capped."],
    } as RelationshipCoverage,
    providerLimitations: [],
    dossierLimitations: [],
    status: "unknown",
    exhaustive: false,
  },
  {
    label: "unknown",
    coverage: {
      status: "unknown",
      reason: "Callee coverage was not established.",
    } as RelationshipCoverage,
    providerLimitations: [],
    dossierLimitations: [],
    status: "unknown",
    exhaustive: false,
  },
  {
    label: "legacy limited",
    coverage: undefined,
    providerLimitations: [
      "Legacy relationship completeness was not established.",
    ],
    dossierLimitations: [],
    status: "unknown",
    exhaustive: false,
  },
  {
    label: "legacy unlimited",
    coverage: undefined,
    providerLimitations: [],
    dossierLimitations: [],
    status: "not_found",
    exhaustive: true,
  },
])(
  "preserves $label coverage through public analyze_function then build_call_path",
  async (scenario) => {
    const base = FUNCTION_COMPARISON_EXAMPLE.left;
    if (base.subject === null) throw new Error("missing fixture subject");
    const provider = {
      id: "fixture",
      name: "Fixture analysis provider",
      version: "1",
    };
    const rawResult = { fixture_reply: scenario.label };
    const execution = createAnalysisExecution(
      {
        ...jsonObjectSchema.parse(base.normalized_result),
        callees: [],
        limitations: scenario.dossierLimitations,
      },
      provider,
      {
        rawResult,
        limitations: scenario.providerLimitations,
        locations: base.locations,
        ...(scenario.coverage === undefined
          ? {}
          : { relationshipCoverage: scenario.coverage }),
      },
    );
    const { session, server, client } = await connected({
      execute: async (operation, parameters) => {
        if (operation === "health") return observed(null);
        if (operation !== "analyze_function")
          throw new Error(`Unexpected operation: ${operation}`);
        expect(parameters.procedure).toBe("0x1000");
        return resultOk(execution);
      },
    });
    try {
      const [path] = await createBinarySessionTargets();
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const analyzed = await client.callTool({
        name: "analyze_function",
        arguments: { procedure: "0x1000" },
      });
      expect(analyzed.isError, JSON.stringify(analyzed)).not.toBe(true);
      const dossier = inlineEvidence(analyzed.structuredContent);
      expect(dossier).toMatchObject({
        operation: "analyze_function",
        parameters: { procedure: "0x1000" },
        provider,
        subject: {
          local_path: path,
          digest: { sha256: session.activeTarget()?.sha256 },
          format: session.activeTarget()?.format,
        },
        raw_result: rawResult,
        limitations: scenario.providerLimitations,
        locations: base.locations,
        normalized_result: {
          callees: [],
          limitations: scenario.dossierLimitations,
        },
      });
      const response = await client.callTool({
        name: "build_call_path",
        arguments: {
          functions: [dossier],
          start: { address: "0x1000" },
          goal: { address: "0x4000" },
        },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const evidence = inlineEvidence(response.structuredContent);
      const coverage = scenario.coverage;
      const reasons =
        coverage?.status === "partial"
          ? coverage.limitations
          : coverage?.status === "unknown"
            ? [coverage.reason]
            : [];
      expect(evidence.normalized_result).toMatchObject({
        status: scenario.status,
        shortest_hops: null,
        paths: [],
        search_scope: { exhaustive: scenario.exhaustive },
        limitations: expect.arrayContaining([
          ...scenario.providerLimitations,
          ...scenario.dossierLimitations,
          ...reasons,
        ]),
      });
      expect(evidence.evidence_links).toEqual([dossier.evidence_id]);
      expect(dossier.relationship_coverage).toEqual(coverage ?? null);
      if (coverage?.status === "partial") {
        const tampered = {
          ...dossier,
          relationship_coverage: { status: "complete" },
        };
        expect(() => parseEvidence(tampered)).toThrow();
        const rejected = await client.callTool({
          name: "build_call_path",
          arguments: {
            functions: [tampered],
            start: { address: "0x1000" },
            goal: { address: "0x4000" },
          },
        });
        expect(rejected.isError, JSON.stringify(rejected)).toBe(true);
      }
      if (scenario.exhaustive)
        expect(session.listUnknowns({ domain: "call-path" })).toEqual([]);
      else
        expect(session.listUnknowns({ domain: "call-path" })).toMatchObject([
          {
            question:
              "Can the requested call path be established from complete analysis?",
            supporting_evidence_ids: [evidence.evidence_id],
          },
        ]);
    } finally {
      await close(session, server, client);
    }
  },
);

it("records a safe unresolved call-path question", async () => {
  const { session, server, client } = await connected();
  const dossier = dossierWithCallees(["0x2000"]);
  expect(session.recordEvidence(dossier).ok).toBe(true);
  try {
    const response = await client.callTool({
      name: "build_call_path",
      arguments: {
        ...INVESTIGATION_EXAMPLES.build_call_path,
        functions: [dossier],
        start: { address: "0x1000" },
        goal: { address: "0x3000" },
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
    const evidence = inlineEvidence(response.structuredContent);
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

it("uses inline assembly observations without recording a false unknown", async () => {
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
      },
    });
    expect(response.isError).not.toBe(true);
    expect(
      session.listUnknowns({ domain: "static-runtime-correlation" }),
    ).toEqual([]);
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
      },
    });
    expect(response.isError).not.toBe(true);
    const evidence = inlineEvidence(response.structuredContent);
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
      },
    });
    expect(response.isError).not.toBe(true);
    const evidence = inlineEvidence(response.structuredContent);
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

const connected = async (analysis?: AnalysisOperationPort) => {
  const session = createTestBinarySession(() => ({
    health: () => Promise.resolve(),
    execute:
      analysis?.execute.bind(analysis) ??
      (() => Promise.resolve(observed(null))),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "investigation-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { session, server, client };
};

const inlineEvidence = (value: unknown) => parseEvidence(value);

const close = async (
  session: BinarySession,
  server: Awaited<ReturnType<typeof createServer>>,
  client: Client,
) => {
  await Promise.allSettled([client.close(), server.close(), session.close()]);
};
