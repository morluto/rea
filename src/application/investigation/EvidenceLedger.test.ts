import { describe, expect, it, vi } from "vitest";
import * as evidenceValidation from "../../domain/evidenceValidation.js";

import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import {
  createEvidence,
  withEvidenceCallerInputPath,
  withEvidenceProviderSelection,
  isImmutableEvidence,
} from "../../domain/evidence.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import { recordUnknownInputSchema } from "../../domain/residualUnknown.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { EvidenceLedger } from "./EvidenceLedger.js";

const TARGET: BinaryTarget = {
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["arm64"],
};
const PROVIDER = { id: "fixture", name: "Fixture provider", version: "1" };

it("updates caller spellings independently while preserving the semantic record", () => {
  const evidence = createEvidence(TARGET, PROVIDER, {
    operation: "health",
    parameters: {},
    result: true,
  });
  const original = withEvidenceCallerInputPath(evidence, undefined, {
    operations_path: "./queries",
    other: "./unchanged",
  });
  const ledger = new EvidenceLedger();
  expect(ledger.record(original)).toEqual({ ok: true, value: "added" });

  const importRecord = (record: typeof original) =>
    ledger.import(createEvidenceBundle([record]));
  const expectReplacement = (
    previous: typeof original,
    current: typeof original,
  ) => {
    expect(current.evidence_id).toBe(original.evidence_id);
    expect(importRecord(current)).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: true,
        replacements: [{ kind: "metadata", previous, current }],
      },
    });
  };

  const selected = withEvidenceCallerInputPath(original, "./selected-alias", {
    operations_path: "./queries",
    other: "./unchanged",
  });
  expectReplacement(original, selected);
  expect(ledger.get(original.evidence_id)?.caller_input_path).toBe(
    "./selected-alias",
  );

  const rebound = withEvidenceCallerInputPath(selected, "./selected-alias", {
    other: "./unchanged",
    operations_path: "./alias/../queries",
  });
  expectReplacement(selected, rebound);
  expect(ledger.get(original.evidence_id)?.caller_input_paths).toEqual({
    operations_path: "./alias/../queries",
    other: "./unchanged",
  });

  const reordered = withEvidenceCallerInputPath(evidence, "./selected-alias", {
    operations_path: "./alias/../queries",
    other: "./unchanged",
  });
  expect(Object.keys(reordered.caller_input_paths ?? {})).toEqual([
    "operations_path",
    "other",
  ]);
  expect(Object.keys(rebound.caller_input_paths ?? {})).toEqual([
    "other",
    "operations_path",
  ]);
  expect(importRecord(reordered)).toMatchObject({
    ok: true,
    value: { changed: false, replacements: [] },
  });
  const unannotated = withEvidenceCallerInputPath(evidence, "./selected-alias");
  expectReplacement(rebound, unannotated);
  expect(ledger.get(original.evidence_id)?.caller_input_paths).toBeUndefined();
});

describe("evidence ledger recording", () => {
  it("deduplicates and atomically imports bundles", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    const ledger = new EvidenceLedger();
    expect(ledger.record(evidence)).toEqual({ ok: true, value: "added" });
    const relocated = createEvidence(
      { ...TARGET, path: "/relocated/different-name" },
      PROVIDER,
      { operation: "health", parameters: {}, result: true },
    );
    expect(relocated.evidence_id).toBe(evidence.evidence_id);
    expect(ledger.record(relocated)).toEqual({
      ok: true,
      value: "duplicate",
    });
    expect(ledger.import(createEvidenceBundle([evidence]))).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: false,
        replacements: [],
      },
    });
    expect(ledger.export().records).toEqual([evidence]);
    const relocatedBundleRecord = createEvidence(
      { ...TARGET, path: "/relocated/fixture-renamed" },
      PROVIDER,
      { operation: "health", parameters: {}, result: true },
    );
    expect(
      ledger.import(createEvidenceBundle([relocatedBundleRecord])),
    ).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: true,
        replacements: [
          {
            kind: "metadata",
            previous: evidence,
            current: relocatedBundleRecord,
          },
        ],
      },
    });
    expect(ledger.get(evidence.evidence_id)).toEqual(relocatedBundleRecord);
    expect(ledger.export().records).toEqual([relocatedBundleRecord]);
    expect(
      ledger.import(createEvidenceBundle([relocatedBundleRecord])),
    ).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: false,
        replacements: [],
      },
    });
    const conflictingBundle = createEvidenceBundle([
      evidence,
      relocatedBundleRecord,
    ]);
    expect(ledger.import(conflictingBundle).ok).toBe(false);
    expect(ledger.get(evidence.evidence_id)).toEqual(relocatedBundleRecord);
  });

  it("ignores JSON object key order during imported identity checks", () => {
    const ledger = new EvidenceLedger();
    const ordered = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: { alpha: 1, beta: 2 },
      result: { alpha: 1, beta: 2 },
    });
    expect(ledger.record(ordered)).toMatchObject({ ok: true, value: "added" });
    const reorderedBundle: unknown = JSON.parse(
      JSON.stringify(
        createEvidenceBundle([
          {
            ...ordered,
            parameters: { beta: 2, alpha: 1 },
            normalized_result: { beta: 2, alpha: 1 },
          },
        ]),
      ),
    );
    expect(ledger.import(reorderedBundle)).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: false,
        replacements: [],
      },
    });
  });

  it("protects borrowed snapshots while preserving detached mutable public reads", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: { nested: { value: "original" } },
    });
    const ledger = new EvidenceLedger();
    expect(ledger.record(evidence).ok).toBe(true);
    const borrowed = ledger.forAnalysis(evidence.evidence_id);
    if (borrowed === undefined) throw new Error("Missing recorded Evidence");
    expect(Object.isFrozen(borrowed)).toBe(true);
    expect(Object.isFrozen(borrowed.normalized_result)).toBe(true);
    expect(Reflect.set(borrowed, "operation", "forged")).toBe(false);
    expect(ledger.forAnalysis(evidence.evidence_id)).toBe(borrowed);
    expect(ledger.record(borrowed)).toEqual({ ok: true, value: "duplicate" });
    const detached = ledger.get(evidence.evidence_id);
    if (detached === undefined) throw new Error("Missing detached Evidence");
    expect(Reflect.set(detached, "operation", "forged")).toBe(true);
    expect(ledger.record(detached).ok).toBe(false);
    expect(ledger.forAnalysis(evidence.evidence_id)).toBe(borrowed);
    const snapshot = ledger.immutableBundle();
    expect(snapshot).toEqual(ledger.export());
    expect(snapshot.records[0]).toBe(borrowed);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    ledger.clear();
    expect(ledger.forAnalysis(evidence.evidence_id)).toBeUndefined();
    expect(ledger.immutableBundle().records).toEqual([]);
    expect(snapshot.records).toEqual([evidence]);
  });
});

describe("evidence ledger metadata imports", () => {
  it("reports and commits metadata replacement when importing unknown history", () => {
    const ledger = new EvidenceLedger();
    const mutation = createEvidence(TARGET, PROVIDER, {
      predicateType: "rea.residual-unknown-mutation",
      operation: "record_unknown",
      parameters: {},
      result: { action: "record", question: "Which path is current?" },
    });
    const created = ledger.recordUnknown(
      recordUnknownInputSchema.parse({
        question: "Which path is current?",
        severity: "high",
        domain: "fixture",
        required_authority: null,
        required_confidence: "derived",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
      }),
      mutation,
    );
    expect(created.ok).toBe(true);
    const relocatedMutation = createEvidence(
      { ...TARGET, path: "/relocated/mutation" },
      PROVIDER,
      {
        predicateType: "rea.residual-unknown-mutation",
        operation: "record_unknown",
        parameters: {},
        result: { action: "record", question: "Which path is current?" },
      },
    );
    expect(relocatedMutation.evidence_id).toBe(mutation.evidence_id);
    const bundle = createEvidenceBundle(
      [relocatedMutation],
      ledger.export().unknowns,
    );

    expect(ledger.import(bundle)).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: true,
        replacements: [
          {
            kind: "metadata",
            previous: mutation,
            current: relocatedMutation,
          },
        ],
      },
    });
    expect(ledger.get(mutation.evidence_id)).toEqual(relocatedMutation);
    expect(ledger.import(bundle)).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: false,
        replacements: [],
      },
    });
  });

  it("retains more than ten thousand inline evidence records", () => {
    const ledger = new EvidenceLedger();
    for (let index = 0; index < 10_001; index += 1) {
      const record = createEvidence(TARGET, PROVIDER, {
        operation: "health",
        parameters: { index },
        result: true,
      });
      expect(ledger.record(record)).toEqual({ ok: true, value: "added" });
    }
    expect(ledger.export().records).toHaveLength(10_001);
  });

  it("retains an inline Evidence record above 64 MiB", () => {
    const ledger = new EvidenceLedger();
    const record = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: "x".repeat(64 * 1024 * 1024 + 1),
    });
    expect(ledger.record(record)).toEqual({ ok: true, value: "added" });
    expect(ledger.get(record.evidence_id)).toEqual(record);
  });
});

describe("evidence bundle imports", () => {
  it("classifies an authenticated Evidence record as the wrong import kind", () => {
    const record = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    const result = new EvidenceLedger().import(record);
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
    if (result.ok) throw new Error("Expected a wrong-kind import failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      message: expect.stringContaining(record.evidence_id),
      details: {
        operation: "import_evidence_bundle",
        issues: [
          {
            path: [],
            reason: "invalid_value",
            observed: { detected_kind: "evidence-record" },
          },
        ],
      },
    });
  });

  it("rejects changed semantics under a retained Evidence ID atomically", () => {
    const ledger = new EvidenceLedger();
    const first = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
      rawResult: { pid: 1 },
    });
    expect(ledger.record(first).ok).toBe(true);
    const bundle = createEvidenceBundle([first]);
    expect(
      ledger.import({
        ...bundle,
        records: [{ ...first, normalized_result: false }],
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
    expect(ledger.export().records).toEqual([first]);
  });
});

const selectedProvider = {
  selection_source: "request" as const,
  candidates: [
    {
      provider: PROVIDER,
      selected: true,
      availability: "available" as const,
      target_support: "supported" as const,
      rejection_codes: [],
    },
  ],
};

it("reconciles an already attributed duplicate using the actual retained metadata", () => {
  const ledger = new EvidenceLedger();
  const old = createEvidence(TARGET, PROVIDER, {
    operation: "read",
    parameters: {},
    result: { value: 1 },
  });
  expect(ledger.record(old).ok).toBe(true);
  const previous = ledger.forAnalysis(old.evidence_id)!;
  const incoming = withEvidenceProviderSelection(
    createEvidence({ ...TARGET, path: "/relocated/fixture" }, PROVIDER, {
      operation: "read",
      parameters: {},
      result: { value: 1 },
    }),
    selectedProvider,
  );
  const result = ledger.recordProduced(incoming, selectedProvider);
  if (!result.ok) throw result.error;
  expect(result.value.disposition).toBe("duplicate");
  expect(result.value.replacements).toHaveLength(1);
  expect(result.value.replacements[0]?.previous).toBe(previous);
  expect(result.value.replacements[0]?.current.subject?.local_path).toBe(
    "/relocated/fixture",
  );
  expect(ledger.forAnalysis(old.evidence_id)?.provider_selection).toEqual(
    selectedProvider,
  );
  const repeated = ledger.recordProduced(
    structuredClone(incoming),
    selectedProvider,
  );
  expect(repeated).toEqual({
    ok: true,
    value: { disposition: "duplicate", replacements: [] },
  });
});

it("exposes the retained handle when duplicate provenance exceeds capacity", () => {
  const original = createEvidence(TARGET, PROVIDER, {
    operation: "capacity",
    parameters: {},
    result: 1,
  });
  const measured = new EvidenceLedger();
  expect(measured.record(original).ok).toBe(true);
  const ledger = new EvidenceLedger({
    maximumRepresentationBytes:
      measured.statistics().retainedRepresentationBytes,
  });
  expect(ledger.record(original).ok).toBe(true);
  const result = ledger.recordProduced(original, selectedProvider);
  if (result.ok) throw new Error("Expected metadata capacity refusal");
  expect(result.error.partialObservation).toEqual({
    kind: "retained-evidence",
    evidence_id: original.evidence_id,
  });
  expect(
    ledger.forAnalysis(original.evidence_id)?.provider_selection,
  ).toBeUndefined();
});

it("preserves sealed foreign bundles without requiring full-payload authentication room", () => {
  const record = withEvidenceProviderSelection(
    createEvidence(TARGET, PROVIDER, {
      operation: "historical",
      parameters: {},
      result: "x".repeat(10000),
    }),
    selectedProvider,
  );
  const source = new EvidenceLedger();
  expect(source.record(record).ok).toBe(true);
  const bundle = source.immutableBundle();
  const ledger = new EvidenceLedger({
    availableAuthenticationBytes: () => 4096,
  });
  expect(ledger.import(bundle).ok).toBe(true);
  expect(ledger.forAnalysis(record.evidence_id)).toBe(record);
  expect(isImmutableEvidence(ledger.forAnalysis(record.evidence_id)!)).toBe(
    true,
  );
});

it("keeps absent historical provenance on borrowed replay handles", () => {
  const ledger = new EvidenceLedger();
  const source = createEvidence(TARGET, PROVIDER, {
    operation: "old",
    parameters: {},
    result: 1,
  });
  expect(ledger.import(createEvidenceBundle([source])).ok).toBe(true);
  const borrowed = ledger.forAnalysis(source.evidence_id)!;
  expect(ledger.recordProduced(borrowed, selectedProvider)).toEqual({
    ok: true,
    value: { disposition: "duplicate", replacements: [] },
  });
  expect(ledger.forAnalysis(source.evidence_id)).toBe(borrowed);
  expect(borrowed.provider_selection).toBeUndefined();
});

it("refuses zero-headroom mutable Evidence before authentication materializes it", () => {
  const value = createEvidence(TARGET, PROVIDER, {
    operation: "unallocated",
    parameters: {},
    result: "large",
  });
  const authenticate = vi.spyOn(
    evidenceValidation,
    "safeParseImmutableEvidence",
  );
  try {
    const ledger = new EvidenceLedger({
      availableAuthenticationBytes: () => 0,
    });
    expect(ledger.recordProduced(value, selectedProvider).ok).toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
    expect(ledger.statistics().evidenceRecords).toBe(0);
  } finally {
    authenticate.mockRestore();
  }
});
