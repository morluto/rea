import { describe, expect, it } from "vitest";

import { traceJavaScriptSemanticsRequestSchema } from "./applicationWorkflowInputContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "./artifactToolContracts.js";
import { JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE } from "./javascriptApplicationWorkflowExamples.js";
import {
  MANAGED_APPLICATION_GRAPH_EXAMPLE,
  MANAGED_MEMBER_COMPARISON_EXAMPLE,
  MANAGED_NATIVE_VERIFICATION_EXAMPLE,
} from "./managedWorkflowExamples.js";
import {
  compareManagedMembersReferenceInputSchema,
  managedApplicationGraphReferenceInputSchema,
  managedNativeVerificationReferenceInputSchema,
} from "./managedWorkflowToolContracts.js";

describe("workflow input contracts", () => {
  it("rejects application Evidence ID references and duplicate inline records", () => {
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

  it("rejects duplicate inline managed Evidence records", () => {
    expect(
      compareManagedMembersReferenceInputSchema.safeParse({
        left: MANAGED_MEMBER_COMPARISON_EXAMPLE.left,
        right: MANAGED_MEMBER_COMPARISON_EXAMPLE.left,
      }).success,
    ).toBe(false);

    expect(
      managedNativeVerificationReferenceInputSchema.safeParse({
        managed_boundaries:
          MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
        native_observations: [
          MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations[0],
          MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations[0],
        ],
      }).success,
    ).toBe(false);

    expect(
      managedApplicationGraphReferenceInputSchema.safeParse({
        managed_artifact: MANAGED_APPLICATION_GRAPH_EXAMPLE.managed_members,
        managed_members: MANAGED_APPLICATION_GRAPH_EXAMPLE.managed_members,
      }).success,
    ).toBe(false);
    expect(
      managedApplicationGraphReferenceInputSchema.safeParse({}).success,
    ).toBe(false);
  });

  it("accepts each complete managed application Evidence source", () => {
    for (const input of [
      { managed_artifact: MANAGED_APPLICATION_GRAPH_EXAMPLE.managed_members },
      { managed_members: MANAGED_APPLICATION_GRAPH_EXAMPLE.managed_members },
      {
        managed_native_boundaries:
          MANAGED_APPLICATION_GRAPH_EXAMPLE.managed_members,
      },
    ])
      expect(
        managedApplicationGraphReferenceInputSchema.safeParse(input).success,
      ).toBe(true);
  });

  it("accepts an explicit artifact integrity continuation policy", () => {
    const input = { integrity_policy: "record-and-continue" as const };
    const inspect = ARTIFACT_TOOL_CONTRACTS.find(
      ({ name }) => name === "inspect_artifact",
    );
    if (inspect === undefined) throw new Error("Missing inspect_artifact");
    expect(inspect.inputSchema.safeParse(input).success).toBe(true);
  });
});
