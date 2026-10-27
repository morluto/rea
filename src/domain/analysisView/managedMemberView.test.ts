import { expect, it } from "vitest";
import { MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE } from "../../contracts/managed/managedWorkflowExamples.js";
import { freezeOwnedJsonTreeSnapshot } from "../immutableJson.js";
import { managedMemberInspectionSchema } from "../managed/managedArtifact.js";
import type { AnalysisViewParent } from "./analysisView.js";
import { projectManagedMemberView } from "./managedMemberView.js";

const parent = (normalizedResult: unknown): AnalysisViewParent => ({
  evidenceId: `ev_${"a".repeat(64)}`,
  operation: "inspect_managed_members",
  normalizedResult,
  sealedResult: true,
  limitations: [],
});

it("revalidates mutable managed facts despite a sealed flag and shallow freeze", () => {
  const source = managedMemberInspectionSchema.parse(
    MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.static_members.normalized_result,
  );
  Object.freeze(source);
  const input = parent(source);
  expect(projectManagedMemberView(input, { kind: "summary" }).ok).toBe(true);
  Object.assign(source.coverage, { state: "invalid" });
  expect(projectManagedMemberView(input, { kind: "summary" })).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("retains historical unknowns while normalizing immutable managed parents", () => {
  const complete = managedMemberInspectionSchema.parse(
    MANAGED_RECONSTRUCTION_IMPORT_EXAMPLE.static_members.normalized_result,
  );
  const {
    signature_resolution: _signature,
    nesting_read: _nesting,
    exported_types: _exported,
    user_strings: _strings,
    selection: _selection,
    method_rows: _rows,
    ...legacy
  } = complete;
  const input = parent(freezeOwnedJsonTreeSnapshot(legacy));
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(projectManagedMemberView(input, { kind: "summary" })).toMatchObject({
      ok: true,
      value: {
        summary: {
          signature_resolution: null,
          nesting_read: null,
          reported_counts: { exported_types: null, user_strings: null },
        },
      },
    });
  }
  expect(Object.hasOwn(legacy, "signature_resolution")).toBe(false);
});
