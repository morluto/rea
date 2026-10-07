import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { compareProcessEvidenceFiles } from "../../../src/application/process/ProcessCli.js";
import { PROCESS_PROVIDER } from "../../../src/application/process/ProcessEvidence.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import {
  FUNCTION_COMPARISON_EVIDENCE,
  INVESTIGATION_EXAMPLES,
} from "../../../src/contracts/investigationExamples.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/contracts/process/processCaptureExample.js";
import { findChangedBehavior } from "../../../src/domain/changedBehavior.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { verifyReconstruction } from "../../../src/domain/reconstructionVerification.js";
import { correlateStaticAndRuntime } from "../../../src/domain/staticRuntimeCorrelation.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const providerNames = [
  "REA process capture",
  "REA deterministic process harness",
];

const captureEvidence = (side: "left" | "right") =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: { side },
    result: EMPTY_PROCESS_CAPTURE_EXAMPLE,
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: "fixture-process",
      platform: "fixture",
      architecture: "fixture",
      isolation: "process",
    },
  });

const inlineEvidence = (response: { structuredContent?: unknown }) =>
  parseEvidence(
    z.object({ evidence: z.unknown() }).parse(response.structuredContent)
      .evidence,
  );

const connectedComparison = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Process comparison must not launch a provider");
  });
  const server = createServer(session, session);
  const client = new Client({
    name: "process-evidence-identity",
    version: "1",
  });
  onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  for (const evidence of [
    FUNCTION_COMPARISON_EXAMPLE.left,
    FUNCTION_COMPARISON_EXAMPLE.right,
    FUNCTION_COMPARISON_EVIDENCE,
  ])
    expect(session.recordEvidence(evidence).ok).toBe(true);
  const left = captureEvidence("left");
  const right = captureEvidence("right");
  const response = await client.callTool({
    name: "compare_process_captures",
    arguments: { left, right },
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  const comparison = inlineEvidence(response);
  expect(comparison.provider).toEqual({
    id: "rea-process",
    name: "REA process capture",
    version: "3",
  });
  expect(comparison.normalized_result).toMatchObject({ status: "unchanged" });
  return { session, client, left, right, comparison };
};

const correlationInput = (comparison: Evidence) => {
  const mapping =
    INVESTIGATION_EXAMPLES.correlate_static_and_runtime.mappings[0];
  if (mapping === undefined) throw new Error("Missing correlation mapping");
  return {
    static_comparisons: [FUNCTION_COMPARISON_EVIDENCE],
    runtime_comparisons: [comparison],
    mappings: [
      {
        ...mapping,
        runtime: {
          ...mapping.runtime,
          comparison_evidence_id: comparison.evidence_id,
        },
      },
    ],
  };
};

const specification = (comparison: Evidence) => ({
  name: "Terminal compatibility",
  claims: [
    {
      kind: "behavioral",
      claim_id: "terminal-output",
      title: "Terminal output remains equivalent",
      comparison_evidence_id: comparison.evidence_id,
      dimension: "terminal",
    },
  ],
});

const consumerCalls = (comparison: Evidence) => [
  {
    name: "find_changed_behavior",
    arguments: { comparisons: [comparison] },
    expected: { behavior_status: "observed_unchanged" },
  },
  {
    name: "correlate_static_and_runtime",
    arguments: correlationInput(comparison),
    expected: { status: "correlated" },
  },
  {
    name: "verify_reconstruction",
    arguments: { specification: specification(comparison) },
    expected: { status: "pass" },
  },
];

const expectConsumerResults = async (client: Client, comparison: Evidence) => {
  for (const { expected, ...call } of consumerCalls(comparison)) {
    const response = await client.callTool(call);
    expect(
      response.isError,
      `${call.name}: ${JSON.stringify(response)}`,
    ).not.toBe(true);
    expect(inlineEvidence(response).normalized_result).toMatchObject(expected);
  }
};

it("feeds the exact public CLI/MCP process comparison into all three MCP consumers", async () => {
  const { client, left, right, comparison } = await connectedComparison();
  const root = await createTestTempDirectory("rea-process-identity-");
  const leftPath = join(root, "left.json");
  const rightPath = join(root, "right.json");
  await Promise.all([
    writeFile(leftPath, JSON.stringify(left)),
    writeFile(rightPath, JSON.stringify(right)),
  ]);
  const cliComparison = parseEvidence(
    await compareProcessEvidenceFiles(leftPath, rightPath),
  );
  expect(cliComparison).toEqual(comparison);
  await expectConsumerResults(client, comparison);
});

type IdentityChange = Partial<
  Pick<
    Evidence,
    | "provider"
    | "predicate_type"
    | "operation"
    | "subject"
    | "confidence"
    | "authority"
  >
>;

// Use the public Evidence builder so each admission control has a valid digest.
const rehashedComparison = (
  base: Evidence,
  change: IdentityChange,
): Evidence => {
  const next = { ...base, ...change };
  const subject = next.subject;
  return createEvidence(
    subject === null
      ? undefined
      : {
          path: subject.local_path,
          sha256: subject.digest.sha256,
          format: subject.format,
          ...(subject.architecture === null
            ? {}
            : { architecture: subject.architecture }),
        },
    next.provider,
    {
      predicateType: next.predicate_type,
      operation: next.operation,
      parameters: next.parameters,
      result: next.normalized_result,
      rawResult: next.raw_result,
      confidence: next.confidence,
      authority: next.authority,
      environment: next.environment,
      limitations: next.limitations,
      locations: next.locations,
      evidenceLinks: next.evidence_links,
    },
  );
};

it.each(providerNames)(
  "admits the exact v3 provider name %s in every MCP consumer",
  async (name) => {
    const { session, client, comparison } = await connectedComparison();
    const admitted = rehashedComparison(comparison, {
      provider: { ...comparison.provider, name },
    });
    expect(parseEvidence(admitted)).toEqual(admitted);
    expect(session.recordEvidence(admitted).ok).toBe(true);
    await expectConsumerResults(client, admitted);
  },
);

const invalidIdentities: ReadonlyArray<{
  label: string;
  change: (base: Evidence) => IdentityChange;
}> = [
  {
    label: "wrong name",
    change: ({ provider }) => ({
      provider: { ...provider, name: `${provider.name} extra` },
    }),
  },
  {
    label: "wrong id",
    change: ({ provider }) => ({
      provider: { ...provider, id: "fixture-process" },
    }),
  },
  {
    label: "old version",
    change: ({ provider }) => ({ provider: { ...provider, version: "2" } }),
  },
  {
    label: "future version",
    change: ({ provider }) => ({ provider: { ...provider, version: "4" } }),
  },
  {
    label: "missing version",
    change: ({ provider }) => ({ provider: { ...provider, version: null } }),
  },
  {
    label: "wrong predicate",
    change: () => ({ predicate_type: "fixture.comparison" }),
  },
  {
    label: "wrong operation",
    change: () => ({ operation: "fixture_comparison" }),
  },
  {
    label: "non-null subject",
    change: () => ({ subject: FUNCTION_COMPARISON_EXAMPLE.left.subject }),
  },
  { label: "wrong confidence", change: () => ({ confidence: "observed" }) },
  {
    label: "wrong authority",
    change: () => ({ authority: "controlled-replay" }),
  },
];

for (const name of providerNames)
  it.each(invalidIdentities)(
    `rejects independently rehashed $label for ${name} in every MCP consumer`,
    async ({ change }) => {
      const { session, client, comparison } = await connectedComparison();
      const named = rehashedComparison(comparison, {
        provider: { ...comparison.provider, name },
      });
      const invalid = rehashedComparison(named, change(named));
      expect(invalid.evidence_id).not.toBe(named.evidence_id);
      expect(parseEvidence(invalid)).toEqual(invalid);
      expect(session.recordEvidence(invalid).ok).toBe(true);
      for (const { expected: _expected, ...call } of consumerCalls(invalid)) {
        const response = await client.callTool(call);
        expect(response.isError, call.name).toBe(true);
        expect(response.structuredContent, call.name).toMatchObject({
          error: { code: "invalid_request" },
        });
      }
    },
  );

it("separately rejects a tampered digest before admission to any consumer or session", async () => {
  const { session, client, comparison } = await connectedComparison();
  const tampered = {
    ...comparison,
    provider: {
      ...comparison.provider,
      name: "REA deterministic process harness",
    },
  };
  const digestMismatch = /semantic identifier does not match/u;
  expect(() => parseEvidence(tampered)).toThrow(digestMismatch);
  expect(() => findChangedBehavior([tampered])).toThrow(digestMismatch);
  expect(() => correlateStaticAndRuntime(correlationInput(tampered))).toThrow(
    digestMismatch,
  );
  const records = session
    .exportEvidenceBundle()
    .records.map((record) =>
      record.evidence_id === tampered.evidence_id ? tampered : record,
    );
  expect(() =>
    verifyReconstruction(
      specification(tampered),
      createEvidenceBundle(records),
    ),
  ).toThrow(digestMismatch);
  expect(session.recordEvidence(tampered).ok).toBe(false);
  for (const { expected: _expected, ...call } of consumerCalls(tampered).filter(
    ({ name }) => name !== "verify_reconstruction",
  )) {
    const response = await client.callTool(call);
    expect(response.isError, call.name).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: { code: "invalid_request" },
    });
  }
});
