import { expect, it } from "vitest";

import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { createEvidence, parseEvidence } from "../../domain/evidence.js";
import {
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewJavaScriptEvidence,
  analysisViewLayoutEvidence,
} from "../../../tests/fixtures/analysisView.js";
import { inspectAnalysisView } from "./AnalysisViewService.js";

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
  expect(JSON.stringify(summary.value.normalized_result)).not.toMatch(
    /semantic_graph/,
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
  expect(JSON.stringify(item.value.normalized_result)).not.toMatch(/secret/);
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
      _tag: "EvidenceReferenceError",
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
