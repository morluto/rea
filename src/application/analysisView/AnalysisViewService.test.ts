import {
  analysisViewCaptureFixture,
  analysisViewCaptureEvidence,
  analysisViewObjectDenseCapture,
} from "../../../tests/fixtures/analysisView.js";
import { describe, expect, it } from "vitest";

import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { createEvidence, parseEvidence } from "../../domain/evidence.js";
import { functionDossierSchema } from "../../domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../domain/ghidraValues.fixture.js";
import {
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewJavaScriptEvidence,
  analysisViewLayoutEvidence,
} from "../../../tests/fixtures/analysisView.js";
import {
  inspectAnalysisView,
  inspectAnalysisViewValidated,
  summarizeRetainedAnalysis,
} from "./AnalysisViewService.js";
import type { Evidence } from "../../domain/evidence.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { err, ok } from "../../domain/result.js";
import { EvidenceLedger } from "../investigation/EvidenceLedger.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../domain/webNetworkCapture.js";
import { inspectAnalysisViewInputSchema } from "../../domain/analysisView/analysisView.js";

it.each(["/fixtures/unknown.exe", ""])(
  "preserves recorded empty native identity fields: path=%j",
  (path) => {
    const original = functionDossierSchema.parse(ghidraFunctionDossier());
    const parent = createEvidence(
      { path, format: "pe", sha256: "c".repeat(64) },
      { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      {
        operation: "analyze_function",
        parameters: {},
        result: {
          ...original,
          procedure: {
            ...original.procedure,
            address: "",
            body: { available: false, reason: "Not recorded" },
          },
        },
      },
    );
    const result = inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: {
        kind: "native",
        facet: "procedure",
        offset: 0,
        limit: 64,
      },
    });
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      procedure_address: "",
      artifact: { path },
      item: { address: "" },
    });
    expect(result.value.locations).toEqual(
      path.length > 0 ? [{ kind: "artifact-path", path }] : [],
    );
  },
);

it("reports inline Evidence identity failures at the complete source path", () => {
  const parent = analysisViewLayoutEvidence();
  const input = {
    source: {
      kind: "inline",
      evidence: { ...parent, evidence_id: `ev_${"0".repeat(64)}` },
    },
    view: { kind: "summary" },
  } as const;

  for (const result of [
    inspectAnalysisView(input),
    inspectAnalysisViewValidated(input),
  ])
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [
          {
            path: ["source", "evidence", "evidence_id"],
            reason: "invalid_value",
            message: "Evidence semantic identifier does not match its record",
          },
        ],
      },
    });
});

it("projects a small native view from an authenticated >10 MiB retained dossier", () => {
  const original = functionDossierSchema.parse(ghidraFunctionDossier());
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

describe("summarizeRetainedAnalysis", () => {
  const parent = analysisViewJavaScriptEvidence(
    analysisViewJavaScriptAnalysisWithSource(),
  );

  it("retains the complete Evidence before projecting its summary", () => {
    const retained = new Map<string, Evidence>();
    const summary = summarizeRetainedAnalysis(parent, {
      recordEvidence: (evidence) => {
        retained.set(evidence.evidence_id, evidence);
        return ok("added");
      },
      evidenceById: (evidenceId) => retained.get(evidenceId),
    });
    if (!summary.ok) throw summary.error;
    expect(retained.get(parent.evidence_id)).toBe(parent);
    expect(summary.value.evidence_links).toEqual([parent.evidence_id]);
    expect(summary.value.normalized_result).toMatchObject({
      kind: "summary",
      parent_evidence_id: parent.evidence_id,
      parent_operation: "analyze_javascript_application",
    });
  });

  it("refuses a summary whose complete Evidence cannot be retained", () => {
    const unavailable = summarizeRetainedAnalysis(parent, {
      recordEvidence: undefined,
      evidenceById: undefined,
    });
    expect(unavailable.ok).toBe(false);
    if (unavailable.ok) return;
    expect(unavailable.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(unavailable.error.userMessage).toContain("detail complete");

    const conflict = new EvidenceIntegrityError("ledger conflict");
    expect(
      summarizeRetainedAnalysis(parent, {
        recordEvidence: () => err(conflict),
        evidenceById: () => parent,
      }),
    ).toEqual(err(conflict));
  });
});

it("seals inferred and literal HAR pages, including a null artifact digest", () => {
  const capture = analysisViewCaptureFixture();
  capture.artifact.sha256 = null;
  const parent = analysisViewCaptureEvidence(capture);
  // Any templated group in the full grouping makes every page inferred.
  for (const [offset, confidence] of [
    [0, "inferred"],
    [11, "inferred"],
  ] as const) {
    const result = inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: { kind: "api-surface", offset, limit: 1 },
    });
    if (!result.ok) throw result.error;
    expect(result.value.confidence).toBe(confidence);
    expect(result.value.subject).toBeNull();
    expect(parseEvidence(result.value)).toEqual(result.value);
  }
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: analysisViewLayoutEvidence() },
      view: { kind: "api-surface" },
    }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisUnsupportedTargetError" },
  });
});

it("rejects a null projected digest under a present parent subject", () => {
  const capture = analysisViewCaptureFixture();
  capture.artifact.sha256 = null;
  const parent = createEvidence(
    { path: capture.artifact.path, sha256: "a".repeat(64), format: "file" },
    { id: "fixture", name: "fixture", version: "1" },
    {
      operation: "inspect_web_network_capture",
      parameters: { sensitive_value_count: 0 },
      result: capture,
      confidence: "observed",
    },
  );
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: { kind: "api-surface" },
    }),
  ).toMatchObject({ ok: false, error: { _tag: "EvidenceIntegrityError" } });
});

it("refuses an object-dense borrowed capture before making a full schema clone", () => {
  const capture = analysisViewObjectDenseCapture();
  expect(Buffer.byteLength(JSON.stringify(capture))).toBeLessThan(
    WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
  );
  const parent = analysisViewCaptureEvidence(capture);
  const ledger = new EvidenceLedger();
  const recorded = ledger.record(parent);
  if (!recorded.ok) throw recorded.error;
  const borrowed = ledger.forAnalysis(parent.evidence_id)!;
  expect(Object.isFrozen(borrowed.normalized_result)).toBe(true);
  const result = inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "api-surface", limit: 1 },
    },
    (id) => ledger.forAnalysis(id),
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      resource: "memory",
    },
  });
  expect(ledger.forAnalysis(parent.evidence_id)).toBe(borrowed);
});

it("borrows inline Evidence until admission without invoking nested accessors", () => {
  let accessed = false;
  const evidence = {
    get normalized_result() {
      accessed = true;
      throw new Error("Evidence must be admitted before parsing");
    },
  };
  const input = {
    source: { kind: "inline", evidence },
    view: { kind: "api-surface" },
  };
  const parsed = inspectAnalysisViewInputSchema.parse(input);
  if (parsed.source.kind !== "inline") throw new Error("Expected inline input");
  expect(parsed.source.evidence).toBe(evidence);
  expect(inspectAnalysisView(input)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(accessed).toBe(false);
});

it("keeps inline-envelope admission live alongside capture validation and grouping", () => {
  // Each clone alone fits; both graphs coexist while the view is projected.
  const capture = analysisViewObjectDenseCapture(40_000);
  const parent = analysisViewCaptureEvidence(capture);
  const retained = inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: { kind: "api-surface" },
    },
    () => parent,
  );
  if (!retained.ok) throw retained.error;
  expect(
    inspectAnalysisView({
      source: { kind: "inline", evidence: parent },
      view: { kind: "api-surface" },
    }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
});

it("admits raw_result and parameters before authenticating a portable capture", () => {
  const dense = analysisViewObjectDenseCapture();
  const parent = analysisViewCaptureEvidence();
  for (const field of ["raw_result", "parameters"] as const) {
    const result = inspectAnalysisView({
      source: { kind: "inline", evidence: { ...parent, [field]: dense } },
      view: { kind: "api-surface" },
    });
    // Refuse expansion before hashing can report the deliberately stale ID.
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
    });
  }
});
