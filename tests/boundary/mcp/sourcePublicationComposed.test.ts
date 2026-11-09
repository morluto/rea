import { expect, it } from "vitest";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { compareFunctionEvidence } from "../../../src/application/investigation/FunctionComparisonEvidence.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { INVESTIGATION_EXAMPLES } from "../../../src/contracts/investigationExamples.js";
import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
} from "../../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { compareApplicationVersionsEvidence } from "../../../src/application/javascript/JavaScriptApplicationWorkflowService.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { recoveryOmissionRemediation } from "../../../src/domain/analysisErrorProjection.js";

it("preserves the source when an inline result with unknown retention exceeds delivery", async () => {
  const session = new BinarySession(
    createTestProviderRouter(() => {
      throw new Error("no provider needed");
    }),
    new InvestigationRecords({ maximumRepresentationBytes: 0 }),
  );
  const input = JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE;
  const full = await createApplicationMcpHarness({ session });
  const request = { name: "compare_application_versions", arguments: input };
  const completeResponse = await full.client.callTool(request);
  const completeError = parseMcpToolError(completeResponse).error;
  expect(completeError.details).toMatchObject({
    partial_observation: {
      kind: "unretained-evidence",
      evidence: { evidence_id: input.left.evidence_id },
    },
    completed_observation: { kind: "inline-evidence", retention: "unknown" },
  });

  // Measure the delivered envelope, including escaped error text and metadata.
  // Contract example growth must not make the source itself exceed this budget.
  const { completed_observation: _completed, ...sourceDetails } =
    completeError.details!;
  const sourceResponse = {
    ...completeResponse,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: { ...completeError, details: sourceDetails },
        }),
      },
    ],
  };
  const sourceBytes = Buffer.byteLength(JSON.stringify(sourceResponse));
  const completeBytes = Buffer.byteLength(JSON.stringify(completeResponse));
  const delivery = createToolResultDelivery(
    Math.ceil((sourceBytes + completeBytes) / 2) + 1024,
  );
  expect(sourceBytes).toBeLessThan(delivery.resultBudgetBytes);
  expect(completeBytes).toBeGreaterThan(delivery.resultBudgetBytes);
  await full.close();

  const boundedSession = new BinarySession(
    createTestProviderRouter(() => {
      throw new Error("no provider needed");
    }),
    new InvestigationRecords({ maximumRepresentationBytes: 0 }),
  );
  const { client } = await createApplicationMcpHarness({
    session: boundedSession,
    serverOptions: { delivery },
  });
  const response = await client.callTool(request);
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(
    delivery.resultBudgetBytes,
  );
  const error = parseMcpToolError(response).error;
  expect(error.remediation.action).toContain(
    recoveryOmissionRemediation("unknown"),
  );
  expect(error).toMatchObject({
    code: "resource_constraint",
    details: {
      partial_observation: {
        kind: "unretained-evidence",
        evidence: input.left,
      },
      completed_observation_omitted: {
        reason: "mcp-response-limit",
        retention: "unknown",
        source_closure: "not-established",
      },
    },
  });
  expect(error.details).not.toHaveProperty("completed_observation");
  expect(error.details).not.toHaveProperty("partial_observation_omitted");
  expect(boundedSession.exportEvidenceBundle().records).toEqual([]);
});

it("does not infer ledger membership from an independently registered reader", async () => {
  const computed = compareApplicationVersionsEvidence(
    JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  );
  if (!computed.ok) throw computed.error;
  const sizing = new InvestigationRecords();
  expect(sizing.recordEvidence(computed.value.evidence).ok).toBe(true);
  const records = new InvestigationRecords({
    maximumRepresentationBytes: sizing.statistics().retainedRepresentationBytes,
  });
  expect(records.recordEvidence(computed.value.evidence).ok).toBe(true);
  const session = new BinarySession(
    createTestProviderRouter(() => {
      throw new Error("no provider needed");
    }),
    records,
  );
  const { client } = await createApplicationMcpHarness({ session });
  const response = await client.callTool({
    name: "compare_application_versions",
    arguments: JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  });
  expect(parseMcpToolError(response).error).toMatchObject({
    details: {
      completed_observation: {
        kind: "inline-evidence",
        retention: "unknown",
        evidence: { evidence_id: computed.value.evidence.evidence_id },
      },
    },
  });
  expect(session.hasEvidence(computed.value.evidence.evidence_id)).toBe(true);
});

it.each([
  {
    name: "compare_process_captures",
    input: INVESTIGATION_EXAMPLES.compare_process_captures.input,
    kind: "unretained-evidence",
  },
  {
    name: "compare_application_versions",
    input: JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
    kind: "inline-evidence",
  },
] as const)(
  "returns completed $name with honest retention when source recording fails",
  async ({ name, input, kind }) => {
    const session = new BinarySession(
      createTestProviderRouter(() => {
        throw new Error("no provider needed");
      }),
      new InvestigationRecords({ maximumRepresentationBytes: 0 }),
    );
    const { client } = await createApplicationMcpHarness({ session });
    const response = await client.callTool({ name, arguments: input });
    const error = parseMcpToolError(response).error;
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: {
        partial_observation: { kind: "unretained-evidence" },
        completed_observation: {
          kind,
          source_closure: "not-established",
          evidence: { operation: name },
        },
      },
    });
    if (kind === "inline-evidence")
      expect(error.details?.completed_observation).toMatchObject({
        retention: "unknown",
      });
    expect(session.exportEvidenceBundle().records).toEqual([]);
  },
);

it.each(["zero", "normal"] as const)(
  "tests completed derived work at %s source capacity",
  async (mode) => {
    const records = new InvestigationRecords(
      mode === "zero" ? { maximumRepresentationBytes: 0 } : {},
    );
    const session = new BinarySession(
      createTestProviderRouter(() => {
        throw new Error("no provider needed");
      }),
      records,
    );
    const { client } = await createApplicationMcpHarness({ session });
    const input = { ...FUNCTION_COMPARISON_EXAMPLE };
    const expected = compareFunctionEvidence(input);
    if (!expected.ok) throw expected.error;
    const response = await client.callTool({
      name: "compare_functions",
      arguments: input,
    });
    if (mode === "zero") {
      expect(response.isError).toBe(true);
      const error = parseMcpToolError(response).error;
      expect(error).toMatchObject({
        code: "resource_constraint",
        details: {
          partial_observation: {
            kind: "unretained-evidence",
            evidence: {
              evidence_id: input.left.evidence_id,
              operation: "analyze_function",
            },
          },
        },
      });
      expect(error).toMatchObject({
        details: {
          completed_observation: {
            kind: "unretained-evidence",
            source_closure: "not-established",
            evidence: { evidence_id: expected.value.evidence.evidence_id },
          },
        },
      });
      expect(records.statistics().evidenceRecords).toBe(0);
    } else {
      expect(response.isError).not.toBe(true);
      expect(parseEvidence(response.structuredContent)).toEqual(
        expected.value.evidence,
      );
      expect(session.hasEvidence(input.left.evidence_id)).toBe(true);
      expect(session.hasEvidence(input.right.evidence_id)).toBe(true);
      expect(session.hasEvidence(expected.value.evidence.evidence_id)).toBe(
        true,
      );
    }
  },
);

it("reports a preexisting primary when source admission fails", async () => {
  const input = { ...FUNCTION_COMPARISON_EXAMPLE };
  const expected = compareFunctionEvidence(input);
  if (!expected.ok) throw expected.error;
  const sizing = new InvestigationRecords();
  expect(sizing.recordEvidence(expected.value.evidence).ok).toBe(true);
  const records = new InvestigationRecords({
    maximumRepresentationBytes: sizing.statistics().retainedRepresentationBytes,
  });
  expect(records.recordEvidence(expected.value.evidence).ok).toBe(true);
  const session = new BinarySession(
    createTestProviderRouter(() => {
      throw new Error("no provider needed");
    }),
    records,
  );
  const { client } = await createApplicationMcpHarness({ session });
  const response = await client.callTool({
    name: "compare_functions",
    arguments: input,
  });
  expect(response.isError).toBe(true);
  expect(parseMcpToolError(response).error).toMatchObject({
    code: "resource_constraint",
    details: {
      partial_observation: {
        kind: "unretained-evidence",
        evidence: { evidence_id: input.left.evidence_id },
      },
      completed_observation: {
        kind: "retained-evidence",
        source_closure: "not-established",
        evidence_id: expected.value.evidence.evidence_id,
      },
    },
  });
  expect(records.statistics()).toMatchObject({
    evidenceRecords: 1,
    unknownRevisions: 0,
  });
});

it.each([
  {
    name: "trace_application_feature",
    input: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  },
  {
    name: "compare_source_to_bundle",
    input: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
  },
] as const)(
  "returns the selected $name view when source publication is refused",
  async ({ name, input }) => {
    const session = new BinarySession(
      createTestProviderRouter(() => {
        throw new Error("no provider needed");
      }),
      new InvestigationRecords({ maximumRepresentationBytes: 0 }),
    );
    const { client } = await createApplicationMcpHarness({ session });
    const result = await client.callTool({
      name,
      arguments: { ...input, view: { kind: "summary" } },
    });
    const { error } = parseMcpToolError(result);
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: {
        partial_observation: { kind: "unretained-evidence" },
        completed_observation: {
          kind: "inline-evidence",
          retention: "unknown",
          source_closure: "not-established",
          evidence: { normalized_result: { kind: "summary" } },
        },
      },
    });
    expect(session.exportEvidenceBundle().records).toEqual([]);
  },
);

it.each([
  {
    name: "trace_application_feature",
    input: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
  },
  {
    name: "compare_source_to_bundle",
    input: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
  },
] as const)(
  "preserves the completed $name parent when a selected view cannot be retained",
  async ({ name, input }) => {
    const router = () =>
      createTestProviderRouter(() => {
        throw new Error("no provider needed");
      });
    const normal = new BinarySession(router(), new InvestigationRecords());
    const normalHarness = await createApplicationMcpHarness({
      session: normal,
    });
    const complete = await normalHarness.client.callTool({
      name,
      arguments: input,
    });
    expect(complete.isError).not.toBe(true);
    const parent = parseEvidence(complete.structuredContent);
    const sizing = new InvestigationRecords();
    expect(parent.evidence_links.length).toBeGreaterThan(0);
    for (const id of parent.evidence_links) {
      const source = normal.evidenceForAnalysis(id);
      if (source === undefined) throw new Error(`Missing source ${id}`);
      expect(sizing.recordEvidence(source).ok).toBe(true);
    }
    const session = new BinarySession(
      router(),
      new InvestigationRecords({
        maximumRepresentationBytes:
          sizing.statistics().retainedRepresentationBytes,
      }),
    );
    const { client } = await createApplicationMcpHarness({ session });
    const result = await client.callTool({
      name,
      arguments: { ...input, view: { kind: "summary" } },
    });
    const { error } = parseMcpToolError(result);
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: {
        partial_observation: {
          kind: "unretained-evidence",
          evidence: { evidence_id: parent.evidence_id, operation: name },
        },
      },
    });
    expect(
      session
        .exportEvidenceBundle()
        .records.map((record) => record.evidence_id)
        .sort(),
    ).toEqual([...parent.evidence_links].sort());
  },
);
