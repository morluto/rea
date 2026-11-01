import { expect, it } from "vitest";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { compareFunctionEvidence } from "../../../src/application/investigation/FunctionComparisonEvidence.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { safeParseEvidence } from "../../../src/domain/evidenceValidation.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";

it.each([
  { profile: "compact", preexisting: false },
  { profile: "compact", preexisting: true },
  { profile: "full", preexisting: false },
  { profile: "full", preexisting: true },
] as const)(
  "preserves the completed comparison on atomic retention failure ($profile schema, preexisting: $preexisting)",
  async ({ profile, preexisting }) => {
    const input = { ...FUNCTION_COMPARISON_EXAMPLE };
    const computed = compareFunctionEvidence(input);
    if (!computed.ok) throw computed.error;
    expect(computed.value.unknown).toBeDefined();
    const initial = [
      input.left,
      input.right,
      ...(preexisting ? [computed.value.evidence] : []),
    ];
    const sizing = new InvestigationRecords();
    for (const evidence of initial)
      expect(sizing.recordEvidence(evidence).ok).toBe(true);
    const records = new InvestigationRecords({
      maximumRepresentationBytes:
        sizing.statistics().retainedRepresentationBytes,
    });
    for (const evidence of initial)
      expect(records.recordEvidence(evidence).ok).toBe(true);
    const session = new BinarySession(
      createTestProviderRouter(() => {
        throw new Error("Comparison must not launch a provider");
      }),
      records,
    );
    const harness = await createApplicationMcpHarness({
      session,
      serverOptions: {
        environment: { ...process.env, REA_MCP_OUTPUT_SCHEMA_PROFILE: profile },
      },
    });
    try {
      const reply = await harness.client.callTool({
        name: "compare_functions",
        arguments: input,
      });
      expect(reply.isError).toBe(true);
      const error = parseMcpToolError(reply).error;
      analysisErrorProjectionSchema.parse(error);
      expect(error).toMatchObject({
        code: "resource_constraint",
        details: { operation: "record_unknown", resource: "capacity" },
      });
      const partial = error.details?.partial_observation;
      if (preexisting) {
        expect(partial).toEqual({
          kind: "retained-evidence",
          evidence_id: computed.value.evidence.evidence_id,
        });
      } else {
        expect(partial).toMatchObject({
          kind: "unretained-evidence",
          evidence: {
            evidence_id: computed.value.evidence.evidence_id,
            operation: "compare_functions",
          },
        });
        const authenticated = safeParseEvidence(
          (partial as { evidence: unknown }).evidence,
        );
        if (!authenticated.ok) throw authenticated.error;
        expect(authenticated.value).toEqual(computed.value.evidence);
      }
      expect(session.hasEvidence(computed.value.evidence.evidence_id)).toBe(
        preexisting,
      );
      expect(session.hasEvidence(input.left.evidence_id)).toBe(true);
      expect(session.hasEvidence(input.right.evidence_id)).toBe(true);
      expect(records.statistics().unknownRevisions).toBe(0);
      const bundle = await harness.client.callTool({
        name: "get_evidence_bundle",
        arguments: { detail: "complete" },
      });
      expect(bundle.isError).not.toBe(true);
      const result = toolContract("get_evidence_bundle").outputSchema.parse(
        bundle.structuredContent,
      );
      const ids = parseEvidenceBundle(result.result).records.map(
        ({ evidence_id }) => evidence_id,
      );
      expect(ids.includes(computed.value.evidence.evidence_id)).toBe(
        preexisting,
      );
    } finally {
      await harness.close();
    }
  },
);
