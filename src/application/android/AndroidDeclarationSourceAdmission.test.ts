import { afterEach, expect, it, vi } from "vitest";
import {
  createEvidence,
  immutableEvidence,
  isImmutableEvidence,
  rebindEvidenceToTargetPath,
  withEvidenceCallerInputPath,
} from "../../domain/evidence.js";
import * as readers from "../../domain/evidenceValidation.js";
import { freezeJsonSnapshot } from "../../domain/immutableJson.js";
import { androidResultSchemas } from "../../domain/android/androidAnalysis.js";
import { androidDeclarationComparisonSchema } from "../../domain/android/androidDeclarationComparison.js";
import { compareAndroidDeclarations } from "./AndroidDeclarationComparisonService.js";
import * as authentication from "../JsonAuthenticationHeadroom.js";
import {
  androidDeclarationEvidence,
  androidDeclarationFacts,
} from "../../../tests/fixtures/android/declarations.js";

afterEach(() => vi.restoreAllMocks());

/** Run the real admission arithmetic against controlled room, without allocating an OOM input. */
const withAuthenticationBytes = (availableBytes: number) => {
  const requireHeadroom = authentication.requireAuthenticationHeadroom;
  return vi
    .spyOn(authentication, "requireAuthenticationHeadroom")
    .mockImplementation((input, options) =>
      requireHeadroom(input, {
        ...options,
        availableBytes,
      }),
    );
};

it("admits complete inline and lookup sources before authentication or Android schema cloning", async () => {
  const source = androidDeclarationEvidence();
  const facts = androidDeclarationFacts();
  const component = facts.components.items[0];
  if (component === undefined) throw new Error("Expected a fixture component");
  const dense = Array.from({ length: 128 }, () => ({ text: "x".repeat(512) }));
  const candidates = [
    { ...source, raw_result: dense },
    { ...source, parameters: { ...source.parameters, retained_input: dense } },
    {
      ...source,
      normalized_result: {
        ...facts,
        manifest: { ...facts.manifest, text: '\u0000"'.repeat(32768) },
      },
    },
    {
      ...source,
      normalized_result: {
        ...facts,
        components: {
          ...facts.components,
          items: Array.from({ length: 128 }, () => component),
        },
      },
    },
  ];
  const authenticate = vi.spyOn(readers, "readImmutableEvidence");
  const parsePackage = vi.spyOn(
    androidResultSchemas.inspect_android_package,
    "safeParse",
  );
  withAuthenticationBytes(100_000);
  for (const candidate of candidates)
    for (const retained of [false, true]) {
      // The complete envelope does not fit; its small declaration projection
      // would fit. The stale semantic ID must never reach clone/hash validation.
      const result = await compareAndroidDeclarations(
        {
          left: retained
            ? { kind: "retained-evidence", evidence_id: source.evidence_id }
            : candidate,
          right: source,
        },
        undefined,
        () => candidate,
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisResourceConstraintError",
          resource: "memory",
          reportedLimits: { input_path: "left" },
          diagnostics: { input_path: ["left"] },
        },
      });
    }
  expect(authenticate).not.toHaveBeenCalled();
  expect(parsePackage).not.toHaveBeenCalled();
});

it("authenticates a repeated mutable source once per request and borrows its validated snapshot", async () => {
  const source = androidDeclarationEvidence();
  const authenticate = vi.spyOn(readers, "readImmutableEvidence");
  const parsePackage = vi.spyOn(
    androidResultSchemas.inspect_android_package,
    "safeParse",
  );
  const result = await compareAndroidDeclarations({
    left: source,
    right: source,
  });
  if (!result.ok) throw result.error;
  expect(authenticate).toHaveBeenCalledTimes(1);
  expect(parsePackage).toHaveBeenCalledTimes(1);
  expect(result.value.sources[0]).toBe(result.value.sources[1]);
  expect(result.value.sources[0]).not.toBe(source);
  expect(isImmutableEvidence(result.value.sources[0])).toBe(true);
});

it("reuses authenticated typed facts across retained calls while preserving each source's display metadata", async () => {
  const original = androidDeclarationEvidence();
  const left = createEvidence(
    { path: "/retained/left.apk", sha256: "a".repeat(64), format: "apk" },
    original.provider,
    {
      operation: original.operation,
      parameters: original.parameters,
      result: original.normalized_result,
      rawResult: { retained_only: "x".repeat(65536) },
    },
    { immutable: true },
  );
  const right = immutableEvidence(
    androidDeclarationEvidence(androidDeclarationFacts(), "right"),
  );
  const parsePackage = vi.spyOn(
    androidResultSchemas.inspect_android_package,
    "safeParse",
  );
  const first = await compareAndroidDeclarations({ left, right });
  if (!first.ok) throw first.error;
  expect(first.value.sources[0]).toBe(left);
  expect(parsePackage).toHaveBeenCalledTimes(2);
  const alias = withEvidenceCallerInputPath(
    rebindEvidenceToTargetPath(left, {
      path: "/selected alias/left.apk",
      sha256: "a".repeat(64),
      format: "apk",
    }),
    "./selected alias.apk",
  );
  const records = new Map(
    [alias, right].map((source) => [source.evidence_id, source]),
  );
  // Enough for the selected comparison, not another full raw_result copy.
  const complete = authentication.estimateJsonStorage(alias);
  expect(
    (complete.valueBytes + complete.serializedUtf16Bytes) * 2,
  ).toBeGreaterThan(200_000);
  withAuthenticationBytes(200_000);
  const retained = await compareAndroidDeclarations(
    {
      left: { kind: "retained-evidence", evidence_id: alias.evidence_id },
      right: { kind: "retained-evidence", evidence_id: right.evidence_id },
    },
    undefined,
    (id) => records.get(id),
  );
  const inline = await compareAndroidDeclarations({ left: alias, right });
  if (!retained.ok) throw retained.error;
  if (!inline.ok) throw inline.error;
  expect(parsePackage).toHaveBeenCalledTimes(2);
  expect(retained.value.evidence.evidence_id).toBe(
    inline.value.evidence.evidence_id,
  );
  expect(retained.value.sources[0]).toBe(alias);
  expect(retained.value.sources[0]?.caller_input_path).toBe(
    "./selected alias.apk",
  );
  const report = androidDeclarationComparisonSchema.parse(
    retained.value.evidence.normalized_result,
  );
  expect(report.left.artifact.path).toBe("/selected alias/left.apk");
  expect(alias.normalized_result).toBe(left.normalized_result);
});

it("validates the Android format even when the Evidence owner has authenticated and sealed the record", async () => {
  const original = androidDeclarationEvidence();
  const malformed = createEvidence(
    { path: "/bad.apk", sha256: "a".repeat(64), format: "apk" },
    original.provider,
    {
      operation: original.operation,
      parameters: original.parameters,
      result: { ...androidDeclarationFacts(), class_count: "not a count" },
    },
    { immutable: true },
  );
  expect(isImmutableEvidence(malformed)).toBe(true);
  const result = await compareAndroidDeclarations({
    left: malformed,
    right: original,
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "EvidenceIntegrityError",
      side: "left",
      issuePath: ["normalized_result", "class_count"],
    },
  });
});

it("does not confuse an owned JSON snapshot or a retained selector with authenticated Evidence", async () => {
  const original = androidDeclarationEvidence();
  const forged = freezeJsonSnapshot({
    ...original,
    raw_result: "x".repeat(65536),
  });
  expect(isImmutableEvidence(forged)).toBe(false);
  const budget = withAuthenticationBytes(100_000);
  const refused = await compareAndroidDeclarations(
    {
      left: { kind: "retained-evidence", evidence_id: original.evidence_id },
      right: original,
    },
    undefined,
    () => forged,
  );
  expect(refused).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  budget.mockRestore();
  expect(
    await compareAndroidDeclarations({ left: forged, right: original }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "EvidenceIntegrityError", side: "left" },
  });
});

it("rejects non-JSON source values before an estimator can access getters or cyclic graphs", async () => {
  const original = androidDeclarationEvidence();
  const getter = vi.fn(() => {
    throw new Error("must not execute a source accessor");
  });
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: getter,
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const raw_result of [accessor, cycle]) {
    const result = await compareAndroidDeclarations({
      left: { ...original, raw_result },
      right: original,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
  }
  expect(getter).not.toHaveBeenCalled();
});

it("yields to queued cancellation before reading, admitting or authenticating source records", async () => {
  const source = androidDeclarationEvidence();
  const authenticate = vi.spyOn(readers, "readImmutableEvidence");
  const parsePackage = vi.spyOn(
    androidResultSchemas.inspect_android_package,
    "safeParse",
  );
  const capacity = vi.spyOn(authentication, "requireAuthenticationHeadroom");
  const lookup = vi.fn(() => source);
  const controller = new AbortController();
  const reason = { cancelled: "before source authentication" };
  const pending = compareAndroidDeclarations(
    {
      left: { kind: "retained-evidence", evidence_id: source.evidence_id },
      right: source,
    },
    { signal: controller.signal },
    lookup,
  );
  controller.abort(reason);
  expect(await pending).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      cause: reason,
    },
  });
  expect(lookup).not.toHaveBeenCalled();
  expect(capacity).not.toHaveBeenCalled();
  expect(authenticate).not.toHaveBeenCalled();
  expect(parsePackage).not.toHaveBeenCalled();
});
