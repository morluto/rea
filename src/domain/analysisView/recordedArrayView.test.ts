import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { MAX_JSON_DEPTH, type JsonValue } from "../jsonValue.js";
import { projectAnalysisError } from "../analysisErrorProjection.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  analysisViewRequestSchema,
  projectAnalysisView,
} from "./analysisView.js";

const nested = (levels: number): JsonValue => {
  let value: JsonValue = "leaf";
  for (let index = 0; index < levels; index += 1) value = { child: value };
  return value;
};

const parent = (
  parameters: JsonValue,
  row: JsonValue = "row",
): AnalysisViewParent => ({
  predicateType: "rea.analysis",
  evidenceId: `ev_${"b".repeat(64)}`,
  operation: "xrefs",
  normalizedResult: ["0x10"],
  rawResult: { values: [row] },
  sealedResult: true,
  provider: { id: "fixture", name: "Fixture", version: "1" },
  artifact: null,
  subject: null,
  parameters,
  limitations: [],
});

const project = (source: AnalysisViewParent) =>
  projectAnalysisView(
    source,
    analysisViewRequestSchema.parse({
      kind: "recorded-array",
      path: ["values"],
      offset: 0,
      limit: 1,
    }),
  );

it("omits parent parameters that would exceed Evidence depth by one level", () => {
  // Parameters are one field below the Evidence root. levels === 999 puts the
  // leaf at depth 1000 there, and one level deeper under normalized_result.
  const parameters = nested(MAX_JSON_DEPTH - 1);
  const admitted = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "xrefs",
      parameters,
      result: ["0x10"],
      rawResult: { values: ["row"] },
    },
  );
  expect(admitted.parameters).toStrictEqual(parameters);
  const projected = project(parent(parameters));
  if (!projected.ok) throw projected.error;
  expect(projected.value).toMatchObject({
    kind: "recorded-array",
    source_parameters: null,
    rows: ["row"],
  });
  expect(projected.value.limitations.join("\n")).toContain("JSON depth");
  expect(() =>
    createEvidence(
      undefined,
      { id: "view", name: "View", version: "1" },
      {
        operation: "inspect_analysis_view",
        parameters: { parent_evidence_id: admitted.evidence_id },
        result: projected.value,
        rawResult: null,
      },
    ),
  ).not.toThrow();
});

it("keeps parameters that still fit one level below the Evidence root", () => {
  const parameters = nested(MAX_JSON_DEPTH - 2);
  const projected = project(parent(parameters));
  if (!projected.ok) throw projected.error;
  expect(projected.value.source_parameters).toEqual(parameters);
});

it("returns a typed depth refusal instead of throwing when a row cannot be nested", () => {
  const projected = project(parent({}, nested(MAX_JSON_DEPTH - 1)));
  expect(projected.ok).toBe(false);
  if (projected.ok) return;
  expect(projectAnalysisError(projected.error)).toMatchObject({
    code: "resource_constraint",
    details: { reported_limits: { maximum_json_depth: MAX_JSON_DEPTH } },
  });
  expect(projectAnalysisError(projected.error).remediation.action).toContain(
    "JSON depth",
  );
});
