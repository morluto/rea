import { describe, expect, it } from "vitest";

import { traceJavaScriptSemanticsRequestSchema } from "./applicationWorkflowInputContracts.js";
import {
  artifactInspectionInputSchema,
  artifactInventoryInputSchema,
} from "./artifactToolContracts.js";
import { JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE } from "./javascriptApplicationWorkflowExamples.js";
import {
  MANAGED_WORKFLOW_TOOL_CONTRACTS,
  compareManagedMembersReferenceInputSchema,
  managedApplicationGraphReferenceInputSchema,
  managedNativeVerificationReferenceInputSchema,
} from "./managedWorkflowToolContracts.js";

const EVIDENCE_ID = `ev_${"a".repeat(64)}`;

const workflowInput = (name: string) => {
  const contract = MANAGED_WORKFLOW_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === name,
  );
  if (contract === undefined) throw new Error(`Missing ${name} contract`);
  return contract.examples[0].input;
};

describe("workflow input contracts", () => {
  it("rejects missing and duplicated application Evidence references", () => {
    const query = {
      seed: { kind: "literal" as const, value: "renderer" },
      direction: "callers" as const,
    };
    expect(
      traceJavaScriptSemanticsRequestSchema.safeParse({ query }).success,
    ).toBe(false);

    const evidence = JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE.application;
    expect(
      traceJavaScriptSemanticsRequestSchema.safeParse({
        application: evidence,
        application_evidence_id: evidence.evidence_id,
        query,
      }).success,
    ).toBe(false);
  });

  it("rejects managed Evidence identity collisions", () => {
    const comparison = workflowInput("compare_managed_members");
    expect(
      compareManagedMembersReferenceInputSchema.safeParse({
        ...comparison,
        left_evidence_id: EVIDENCE_ID,
        right_evidence_id: EVIDENCE_ID,
      }).success,
    ).toBe(false);

    const native = workflowInput("verify_managed_native_boundaries");
    expect(
      managedNativeVerificationReferenceInputSchema.safeParse({
        ...native,
        managed_boundaries_evidence_id: EVIDENCE_ID,
        native_observation_evidence_ids: [EVIDENCE_ID, EVIDENCE_ID],
      }).success,
    ).toBe(false);

    expect(
      managedApplicationGraphReferenceInputSchema.safeParse({
        managed_artifact_evidence_id: EVIDENCE_ID,
        managed_members_evidence_id: EVIDENCE_ID,
      }).success,
    ).toBe(false);
    expect(
      managedApplicationGraphReferenceInputSchema.safeParse({}).success,
    ).toBe(false);
  });

  it("accepts each complete managed application Evidence source", () => {
    for (const input of [
      { managed_artifact_evidence_id: EVIDENCE_ID },
      { managed_members_evidence_id: EVIDENCE_ID },
      { managed_native_boundaries_evidence_id: EVIDENCE_ID },
    ])
      expect(
        managedApplicationGraphReferenceInputSchema.safeParse(input).success,
      ).toBe(true);
  });

  it("requires explicit approval for record-and-continue artifact inspection", () => {
    const input = {
      integrity_policy: "record-and-continue" as const,
      integrity_continue_approved: false,
    };
    expect(artifactInventoryInputSchema.safeParse(input).success).toBe(false);
    expect(artifactInspectionInputSchema.safeParse(input).success).toBe(false);
  });
});
