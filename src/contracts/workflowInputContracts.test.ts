import { describe, expect, it } from "vitest";

import { toolContract } from "./toolContracts.js";
import { toolInputSchemaWithMetadata } from "./toolSchemaMetadata.js";

import { traceJavaScriptSemanticsRequestSchema } from "./javascript/applicationWorkflowInputContracts.js";
import { JAVASCRIPT_FEATURE_TRACE_EXAMPLE } from "./javascript/javascriptApplicationWorkflowExamples.js";
import {
  MANAGED_APPLICATION_GRAPH_EXAMPLE,
  MANAGED_MEMBER_COMPARISON_EXAMPLE,
  MANAGED_NATIVE_VERIFICATION_EXAMPLE,
  MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE,
} from "./managed/managedWorkflowExamples.js";
import { parseEvidence } from "../domain/evidence.js";
import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";
import { managedApplicationGraphReferenceInputSchema } from "../domain/managed/managedApplicationGraph.js";

describe("workflow input contracts", () => {
  it("keeps the shared managed example's complete MethodDef scope consistent", () => {
    const source = MANAGED_APPLICATION_GRAPH_EXAMPLE.managed_members;
    const members = managedMemberInspectionSchema.parse(
      source.normalized_result,
    );
    expect(members.methods.map((method) => method.token)).toEqual([
      "0x06000001",
    ]);
    expect(members.method_rows).toEqual({ offset: 0, count: 1, total: 1 });
    expect(members.coverage).toEqual({ state: "complete", issues: [] });
    expect(members.selection).toBeNull();
    expect(parseEvidence(source)).toEqual(source);
    expect(MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.static_members).toBe(source);
  });

  it("rejects application Evidence ID references and duplicate inline records", () => {
    const query = {
      seed: { kind: "literal" as const, value: "renderer" },
      direction: "callers" as const,
    };
    expect(
      traceJavaScriptSemanticsRequestSchema.safeParse({ query }).success,
    ).toBe(false);

    const evidence = JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application;
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
      toolContract("compare_managed_members").inputSchema.safeParse({
        left: MANAGED_MEMBER_COMPARISON_EXAMPLE.left,
        right: MANAGED_MEMBER_COMPARISON_EXAMPLE.left,
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

  it.each([
    {
      name: "one observation reusing the boundary",
      observations: [MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries],
      issues: [
        {
          path: ["native_observations", 0],
          message: expect.stringMatching(
            /native observation Evidence.*distinct.*managed boundary Evidence/i,
          ),
        },
      ],
    },
    {
      name: "repeated native observations",
      observations: [
        MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations[0],
        MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations[0],
      ],
      issues: [
        {
          path: ["native_observations", 1],
          message: expect.stringMatching(
            /native observation Evidence IDs.*unique/i,
          ),
        },
      ],
    },
    {
      name: "repeated observations reusing the boundary",
      observations: [
        MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
        MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
      ],
      issues: [
        {
          path: ["native_observations", 0],
          message: expect.stringMatching(
            /native observation Evidence.*distinct.*managed boundary Evidence/i,
          ),
        },
        {
          path: ["native_observations", 1],
          message: expect.stringMatching(
            /native observation Evidence.*distinct.*managed boundary Evidence/i,
          ),
        },
        {
          path: ["native_observations", 1],
          message: expect.stringMatching(
            /native observation Evidence IDs.*unique/i,
          ),
        },
      ],
    },
    {
      name: "distinct native observations",
      observations: MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations,
      issues: [],
    },
  ])(
    "preserves managed/native diagnostics for $name",
    async ({ observations, issues }) => {
      const input = {
        managed_boundaries:
          MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
        native_observations: observations,
      };
      const contract = toolContract("verify_managed_native_boundaries");
      let originalDiagnostics: unknown;
      for (const schema of [
        contract.inputSchema,
        toolInputSchemaWithMetadata(contract),
      ]) {
        const result = await schema["~standard"].validate(input);
        const diagnostics =
          result.issues?.map(({ path, message }) => ({ path, message })) ?? [];
        expect(diagnostics).toEqual(issues);
        if (originalDiagnostics === undefined)
          originalDiagnostics = diagnostics;
        else expect(diagnostics).toEqual(originalDiagnostics);
        if (issues.length === 0) expect(result).toEqual({ value: input });
      }
    },
  );
});
