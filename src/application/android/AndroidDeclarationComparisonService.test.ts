import { expect, it } from "vitest";
import { createEvidence, parseEvidence } from "../../domain/evidence.js";
import { unknownTarget } from "../../domain/targetIdentity.js";
import { compareAndroidDeclarations } from "./AndroidDeclarationComparisonService.js";
import {
  androidDeclarationEvidence,
  androidDeclarationFacts,
} from "../../../tests/fixtures/android/declarations.js";
import { inspectAnalysisView } from "../analysisView/AnalysisViewService.js";
import {
  androidDeclarationComparisonSchema,
  compareAndroidDeclarationFacts,
} from "../../domain/android/androidDeclarationComparison.js";
import { retainAnalysisResultSources } from "../investigation/recordEvidenceSources.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { err } from "../../domain/result.js";
import { requireAndroidDeclarationComparisonHeadroom } from "./AndroidDeclarationComparisonAdmission.js";
import { estimateJsonStorage } from "../JsonAuthenticationHeadroom.js";

it("admits expanded declaration rows before grouping without charging unrelated manifest text", () => {
  const left = androidDeclarationFacts(
    '<provider android:name=".Data" android:authorities="one;two"/>',
  );
  const right = androidDeclarationFacts('<service android:name=".New"/>');
  const repeated = 'quoted"\u0000😀'.repeat(64);
  left.permissions = [repeated, repeated];
  const report = compareAndroidDeclarationFacts(left, right);
  const variable = estimateJsonStorage({
    changes: report.components.changes,
    observed_only_left: report.permissions.observed_only_left,
    observed_only_right: report.permissions.observed_only_right,
    observed_both: report.permissions.observed_both,
  });
  const refused = requireAndroidDeclarationComparisonHeadroom(
    {},
    left,
    right,
    0,
  );
  if (refused.ok) throw new Error("Expected exhausted heap admission");
  expect(refused.error.resource).toBe("memory");
  const limits = refused.error.reportedLimits;
  expect(limits?.projected_value_bytes).toBeGreaterThanOrEqual(
    variable.valueBytes,
  );
  expect(limits?.serialized_json_utf16_bytes).toBeGreaterThanOrEqual(
    variable.serializedUtf16Bytes,
  );
  const withText = {
    ...left,
    manifest: { ...left.manifest, text: "unrelated".repeat(10000) },
  };
  const same = requireAndroidDeclarationComparisonHeadroom(
    {},
    withText,
    right,
    0,
  );
  if (same.ok) throw new Error("Expected exhausted heap admission");
  expect(same.error.reportedLimits).toEqual(limits);
  expect(
    requireAndroidDeclarationComparisonHeadroom(
      {},
      left,
      right,
      Number.MAX_SAFE_INTEGER,
    ).ok,
  ).toBe(true);
});

it("resolves exact retained inputs and retains APK identity separately from engine/path spelling", async () => {
  const left = androidDeclarationEvidence();
  const facts = androidDeclarationFacts();
  facts.package_name = "another.application";
  facts.version_name = null;
  const right = androidDeclarationEvidence(facts, "right");
  const records = new Map(
    [left, right].map((source) => [source.evidence_id, source]),
  );
  const result = await compareAndroidDeclarations(
    {
      left: { kind: "retained-evidence", evidence_id: left.evidence_id },
      right: { kind: "retained-evidence", evidence_id: right.evidence_id },
    },
    undefined,
    (id) => records.get(id),
  );
  if (!result.ok) throw result.error;
  expect(result.sourceEvidence).toEqual([left, right]);
  const evidence = parseEvidence(result.value.evidence);
  const report = androidDeclarationComparisonSchema.parse(
    evidence.normalized_result,
  );
  expect(report.left).toMatchObject({
    artifact: { path: "/retained/left.apk", sha256: "a".repeat(64) },
    input_path: "./selected-left.apk",
    engine: { artifact_sha256: "e".repeat(64) },
    package_name: "example.fixture",
  });
  expect(report.right).toMatchObject({
    package_name: "another.application",
    version_name: null,
  });
  expect(evidence.confidence).toBe("derived");
  expect(evidence.evidence_links).toEqual([
    left.evidence_id,
    right.evidence_id,
  ]);
  expect(evidence.subject.identity).toEqual(
    unknownTarget("derived-from-linked-evidence"),
  );
  const failure = new AnalysisInputError("record_evidence", {
    userMessage: "retention rejected",
  });
  expect(
    retainAnalysisResultSources(
      "compare_android_declarations",
      () => err(failure),
      result,
    ),
  ).toEqual(err(failure));
});

it("rejects tampering, wrong roles, missing APK identity and malformed declarations", async () => {
  const source = androidDeclarationEvidence();
  const observation = {
    operation: source.operation,
    parameters: source.parameters,
    result: source.normalized_result,
  };
  const provider = source.provider;
  const badSources = [
    { ...source, normalized_result: { changed: true } },
    createEvidence(unknownTarget("not-observed"), provider, observation),
    createEvidence(
      { path: "/x.apk", sha256: "a".repeat(64), format: "zip" },
      provider,
      observation,
    ),
    createEvidence(
      { path: "/x.apk", sha256: "a".repeat(64), format: "apk" },
      provider,
      { ...observation, operation: "search_android_classes" },
    ),
    createEvidence(
      { path: "/x.apk", sha256: "a".repeat(64), format: "apk" },
      provider,
      { ...observation, parameters: {} },
    ),
    createEvidence(
      { path: "/x.apk", sha256: "a".repeat(64), format: "apk" },
      provider,
      {
        ...observation,
        result: {
          ...androidDeclarationFacts(),
          components: {
            status: "complete",
            items: [{ invalid: true }],
            limitations: [],
          },
        },
      },
    ),
  ];
  for (const left of badSources) {
    const result = await compareAndroidDeclarations({ left, right: source });
    expect(result.ok).toBe(false);
  }
});

it("gives exact parent recovery for summary input and never silently follows it", async () => {
  const source = androidDeclarationEvidence();
  const summary = await inspectAnalysisView({
    source: { kind: "inline", evidence: source },
    view: { kind: "summary" },
  });
  if (!summary.ok) throw summary.error;
  const result = await compareAndroidDeclarations({
    left: summary.value,
    right: source,
  });
  if (result.ok) throw new Error("Expected summary rejection");
  expect(result.error._tag).toBe("AnalysisInputError");
  expect(result.error.userMessage).toContain(source.evidence_id);
  expect(
    await compareAndroidDeclarations({
      left: { kind: "retained-evidence", evidence_id: source.evidence_id },
      right: source,
    }),
  ).toMatchObject({ ok: false, error: { _tag: "EvidenceIntegrityError" } });
});

it("preserves cancellation reasons before admission and while a comparison is queued", async () => {
  const source = androidDeclarationEvidence();
  const reason = { stop: "comparison" };
  const cancelled = await compareAndroidDeclarations(
    { left: source, right: source },
    { signal: AbortSignal.abort(reason) },
  );
  expect(cancelled).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError", cause: reason },
  });
  const controller = new AbortController();
  const pending = compareAndroidDeclarations(
    { left: source, right: source },
    { signal: controller.signal },
  );
  controller.abort(reason);
  expect(await pending).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError", cause: reason },
  });
});
