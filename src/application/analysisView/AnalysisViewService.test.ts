import { expect, it } from "vitest";

import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { createEvidence, parseEvidence } from "../../domain/evidence.js";
import { ghidraFunctionDossier } from "../../domain/ghidraValues.fixture.js";
import {
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewJavaScriptEvidence,
  analysisViewLayoutEvidence,
} from "../../../tests/fixtures/analysisView.js";
import { inspectAnalysisView } from "./AnalysisViewService.js";

it("projects a small native view from an authenticated >10 MiB retained dossier", () => {
  const original = ghidraFunctionDossier() as Record<string, unknown>;
  const parent = createEvidence(
    { path: "/fixtures/large.exe", format: "pe", sha256: "c".repeat(64) },
    { id: "ghidra", name: "Ghidra", version: "12.1.4" },
    {
      operation: "analyze_function",
      parameters: { address: "0x401000" },
      result: { ...original, pseudocode: "X".repeat(11 * 1024 * 1024) },
      limitations: ["Synthetic fixture"],
    },
  );
  const input = {
    source: {
      kind: "retained-evidence" as const,
      evidence_id: parent.evidence_id,
    },
    view: {
      kind: "native" as const,
      facet: "pseudocode" as const,
      offset: 0,
      limit: 128,
    },
  };
  const view = inspectAnalysisView(input, (id) =>
    id === parent.evidence_id ? parent : undefined,
  );
  if (!view.ok) throw view.error;
  expect(view.value.evidence_links).toEqual([parent.evidence_id]);
  expect(view.value.normalized_result).toMatchObject({
    kind: "native",
    parent_operation: "analyze_function",
    parent_evidence_id: parent.evidence_id,
    procedure_address: "0x401000",
    artifact: { path: "/fixtures/large.exe", sha256: "c".repeat(64) },
    coverage: { total: 11 * 1024 * 1024, examined: 128, next_offset: 128 },
  });
  expect(view.value.locations).toEqual([
    { kind: "artifact-path", path: "/fixtures/large.exe" },
    { kind: "address", address: "0x401000" },
  ]);
  expect(JSON.stringify(view.value).length).toBeLessThan(12000);
  expect(JSON.stringify(parent).length).toBeGreaterThan(10 * 1024 * 1024);
  expect(inspectAnalysisView(input, () => undefined)).toMatchObject({
    ok: false,
    error: { _tag: "EvidenceIntegrityError" },
  });
});

it("projects inline layout Evidence and retains a derived view record", () => {
  const parent = analysisViewLayoutEvidence();
  const result = inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: {
      kind: "item",
      collection: "sections",
      selector: { index: 2 },
    },
  });
  if (!result.ok) throw result.error;
  const evidence = parseEvidence(result.value);
  expect(evidence.operation).toBe("inspect_analysis_view");
  expect(evidence.predicate_type).toBe("rea.analysis-view");
  expect(evidence.confidence).toBe("derived");
  expect(evidence.evidence_links).toEqual([parent.evidence_id]);
  expect(evidence.normalized_result).toMatchObject({
    kind: "item",
    parent_evidence_id: parent.evidence_id,
    item: { name: { display: ".data" } },
  });
});

it("resolves same-session retained JavaScript Evidence without re-running analysis", () => {
  const parent = analysisViewJavaScriptEvidence(
    analysisViewJavaScriptAnalysisWithSource(),
  );
  const lookup = (evidenceId: string) =>
    evidenceId === parent.evidence_id ? parent : undefined;
  const summary = inspectAnalysisView(
    {
      source: {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      },
      view: { kind: "summary" },
    },
    lookup,
  );
  if (!summary.ok) throw summary.error;
  expect(summary.value.normalized_result).toMatchObject({
    kind: "summary",
    parent_evidence_id: parent.evidence_id,
    parent_operation: "analyze_javascript_application",
  });
  expect(summary.value.normalized_result).not.toHaveProperty(
    "summary.semantic_graph",
  );
  const item = inspectAnalysisView(
    {
      source: {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      },
      view: {
        kind: "item",
        collection: "modules",
        selector: { path: "renderer.js" },
      },
    },
    lookup,
  );
  if (!item.ok) throw item.error;
  expect(JSON.stringify(item.value.normalized_result)).toContain(
    "export const secret = 1;",
  );
});

it("rejects stale retained IDs and unsupported parent operations", () => {
  const missing = inspectAnalysisView(
    {
      source: {
        kind: "retained-evidence",
        evidence_id: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.evidence_id,
      },
      view: { kind: "summary" },
    },
    () => undefined,
  );
  expect(missing).toMatchObject({
    ok: false,
    error: {
      _tag: "EvidenceIntegrityError",
      evidenceId: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.evidence_id,
    },
  });
  const unsupported = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "inspect_recorded_crash",
      parameters: {},
      result: { path: "/artifacts/crash.core" },
    },
  );
  const rejected = inspectAnalysisView({
    source: { kind: "inline", evidence: unsupported },
    view: { kind: "summary" },
  });
  expect(rejected).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisUnsupportedTargetError" },
  });
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: analysisViewLayoutEvidence() },
      view: { kind: "summary", approval: true },
    }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("preserves an absent parent subject instead of guessing its format", () => {
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const original = analysisViewJavaScriptEvidence(analysis);
  const parent = createEvidence(undefined, original.provider, {
    operation: original.operation,
    parameters: {},
    result: original.normalized_result,
    limitations: original.limitations,
  });
  const result = inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    },
    () => parent,
  );
  if (!result.ok) throw result.error;
  expect(result.value.subject).toBeNull();
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: analysis.input_path },
  ]);
});

it("rejects contradictory subject and analysis artifact digests", () => {
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const original = analysisViewJavaScriptEvidence(analysis);
  const parent = createEvidence(
    {
      path: analysis.input_path,
      format: analysis.format,
      sha256: "d".repeat(64),
    },
    original.provider,
    {
      operation: original.operation,
      parameters: {},
      result: original.normalized_result,
    },
  );
  const result = inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "summary" },
    },
    () => parent,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "EvidenceIntegrityError" },
  });
});
