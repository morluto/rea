import { expect, it } from "vitest";

import { ANALYSIS_EVIDENCE_PREDICATE } from "../evidence.js";

import {
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

const parent = (normalizedResult: unknown): AnalysisViewParent => ({
  evidenceId: `ev_${"a".repeat(64)}`,
  operation: "procedure_pseudo_code",
  predicateType: ANALYSIS_EVIDENCE_PREDICATE,
  normalizedResult,
  parameters: { procedure: "file-offset:0x1000", document: "" },
  artifact: { path: "", sha256: "b".repeat(64) },
  limitations: ["Recorded provider limitation"],
});

it("preserves the selected document and file-offset without inventing a canonical function address", () => {
  const source = parent("A😀\r\n尾\n");
  const summary = projectAnalysisView(source, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value).toMatchObject({
    summary: {
      selection: source.parameters,
      pseudocode: { available: true, code_units: 7 },
    },
    artifact: source.artifact,
    limitations: source.limitations,
  });
  const first = projectAnalysisView(source, {
    kind: "native",
    facet: "pseudocode",
    offset: 0,
    limit: 2,
  });
  if (!first.ok) throw first.error;
  expect(first.value).toMatchObject({
    procedure_address: null,
    item: { text: "A" },
    coverage: { next_offset: 1 },
  });
  const second = projectAnalysisView(source, {
    kind: "native",
    facet: "pseudocode",
    offset: 1,
    limit: 2,
  });
  if (!second.ok) throw second.error;
  expect(second.value).toMatchObject({
    item: { text: "😀" },
    coverage: { next_offset: 3 },
  });
  expect(
    projectAnalysisView(source, {
      kind: "native",
      facet: "pseudocode",
      offset: 2,
      limit: 2,
    }),
  ).toMatchObject({ ok: false, error: { issues: [{ path: ["view"] }] } });
  const beyond = projectAnalysisView(source, {
    kind: "native",
    facet: "pseudocode",
    offset: 100,
    limit: 2,
  });
  if (!beyond.ok) throw beyond.error;
  expect(beyond.value).toMatchObject({
    item: { text: "" },
    coverage: { total: 7, exhausted: true, next_offset: null },
  });
  expect(source.normalizedResult).toBe("A😀\r\n尾\n");
});

it("rejects malformed parent facts at their owning source paths", () => {
  const invalidResult = projectAnalysisView(parent({ text: "not a scalar" }), {
    kind: "summary",
  });
  expect(invalidResult).toMatchObject({
    ok: false,
    error: { issues: [{ path: ["source", "normalized_result"] }] },
  });
  const invalidSelection = projectAnalysisView(
    { ...parent("text"), parameters: { procedure: 1 } },
    { kind: "summary" },
  );
  expect(invalidSelection).toMatchObject({
    ok: false,
    error: { issues: [{ path: ["source", "parameters", "procedure"] }] },
  });
  expect(
    projectAnalysisView(
      { ...parent("text"), artifact: null },
      { kind: "summary" },
    ),
  ).toMatchObject({
    ok: false,
    error: { issues: [{ path: ["source", "subject"] }] },
  });
});

it("refuses unrelated dossier facets for a scalar pseudocode observation", () => {
  expect(
    projectAnalysisView(parent("text"), {
      kind: "native",
      facet: "assembly",
      offset: 0,
      limit: 1,
    }),
  ).toMatchObject({ ok: false, error: { issues: [{ path: ["view"] }] } });
});
