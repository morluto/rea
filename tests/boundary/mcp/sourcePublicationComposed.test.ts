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
import { JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE } from "../../../src/contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { compareApplicationVersionsEvidence } from "../../../src/application/javascript/JavaScriptApplicationWorkflowService.js";

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
