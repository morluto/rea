import { expect, it, vi } from "vitest";

import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  createEvidenceBundle,
  createImmutableEvidenceBundle,
  isImmutableEvidenceBundle,
} from "../../domain/evidenceBundle.js";
import {
  recordUnknownInputSchema,
  updateUnknownInputSchema,
  type ResidualUnknown,
} from "../../domain/residualUnknown.js";
import { InvestigationRecords } from "./InvestigationRecords.js";
import { isImmutableJsonSnapshot } from "../../domain/immutableJson.js";

const provider = { id: "fixture", name: "Retention fixture", version: "1" };
const observe = (index: number, path = "/fixture") =>
  createEvidence(
    { path, sha256: "a".repeat(64), format: "file" },
    provider,
    { operation: "health", parameters: { index }, result: { value: index } },
    { immutable: true },
  );
const unknownInput = recordUnknownInputSchema.parse({
  question: "Which observation completes this investigation?",
  severity: "medium",
  domain: "retention-fixture",
  required_authority: null,
  required_confidence: "derived",
  required_environment: null,
  recommended_probes: [],
  relationships: [],
});
const updateInput = (unknown: ResidualUnknown) =>
  updateUnknownInputSchema.parse({
    unknown_id: unknown.unknown_id,
    expected_revision: unknown.revision,
    status: "investigating",
    severity: unknown.severity,
    supporting_evidence_ids: unknown.supporting_evidence_ids,
    contradicting_evidence_ids: unknown.contradicting_evidence_ids,
    required_authority: unknown.required_authority,
    required_confidence: unknown.required_confidence,
    required_environment: unknown.required_environment,
    recommended_probes: unknown.recommended_probes,
    relationships: unknown.relationships,
    resolution: unknown.resolution,
  });

/** A completed unrestricted control supplies admission boundaries without repeating the estimator. */
const recordCost = (evidence: Evidence): number => {
  const records = new InvestigationRecords({
    maximumRepresentationBytes: Number.MAX_SAFE_INTEGER,
  });
  const result = records.recordEvidence(evidence);
  if (!result.ok) throw result.error;
  return records.statistics().retainedRepresentationBytes;
};

it("returns only authenticated Evidence when a completed record exceeds retention capacity", () => {
  const evidence = observe(7);
  const records = new InvestigationRecords({ maximumRepresentationBytes: 0 });
  const refused = records.recordEvidence(evidence);
  if (refused.ok) throw new Error("Expected retention refusal");
  expect(refused.error._tag).toBe("AnalysisResourceConstraintError");
  expect(refused.error.partialObservation).toEqual({
    kind: "unretained-evidence",
    evidence,
  });
  expect(isImmutableJsonSnapshot(refused.error.partialObservation)).toBe(true);
  expect(records.hasEvidence(evidence.evidence_id)).toBe(false);
  const invalid = records.recordEvidence({
    ...evidence,
    normalized_result: "tampered",
  });
  if (invalid.ok) throw new Error("Expected integrity refusal");
  expect(invalid.error._tag).toBe("EvidenceIntegrityError");
  expect(invalid.error.partialObservation).toBeUndefined();
  const mutable = createEvidence(undefined, provider, {
    operation: "health",
    parameters: {},
    result: { value: 1 },
  });
  const noHeadroom = new InvestigationRecords({
    availableAuthenticationBytes: () => 0,
  }).recordEvidence(mutable);
  if (noHeadroom.ok)
    throw new Error("Expected authentication headroom refusal");
  expect(noHeadroom.error._tag).toBe("AnalysisResourceConstraintError");
  expect(noHeadroom.error.partialObservation).toBeUndefined();
});

it("admits exact capacity, rejects cumulative growth atomically, and releases accounting on clear", () => {
  const first = observe(1);
  const second = observe(2);
  const maximum = recordCost(first);
  const records = new InvestigationRecords({
    maximumRepresentationBytes: maximum,
  });
  expect(records.recordEvidence(first)).toEqual({ ok: true, value: "added" });
  const before = records.statistics();
  const borrowed = records.evidenceForAnalysis(first.evidence_id);
  expect(records.recordEvidence(borrowed ?? first)).toEqual({
    ok: true,
    value: "duplicate",
  });
  expect(records.statistics()).toEqual(before);
  expect(records.recordEvidence(second)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "capacity" },
  });
  expect(records.statistics()).toEqual(before);
  expect(records.evidenceForAnalysis(first.evidence_id)).toBe(borrowed);
  expect(records.hasEvidence(second.evidence_id)).toBe(false);

  records.clear();
  expect(records.statistics()).toEqual({
    evidenceRecords: 0,
    unknownRevisions: 0,
    unknownHeads: 0,
    retainedRepresentationBytes: 0,
    maximumRepresentationBytes: maximum,
  });
  expect(records.recordEvidence(first)).toEqual({ ok: true, value: "added" });
  expect(records.statistics()).toEqual(before);
});

it("admits complete bundle transactions before committing any new record", () => {
  const first = observe(1);
  const second = observe(2);
  const records = new InvestigationRecords({
    maximumRepresentationBytes: recordCost(first),
  });
  const before = records.statistics();
  expect(
    records.mergeEvidenceBundle(createImmutableEvidenceBundle([first, second])),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "capacity" },
  });
  expect(records.statistics()).toEqual(before);
  expect(records.exportEvidenceBundle()).toEqual(createEvidenceBundle([]));

  expect(records.recordEvidence(first).ok).toBe(true);
  const committed = records.statistics();
  expect(
    records.mergeEvidenceBundle(createImmutableEvidenceBundle([first, second]))
      .ok,
  ).toBe(false);
  expect(records.statistics()).toEqual(committed);
  expect(records.hasEvidence(second.evidence_id)).toBe(false);
});

it("accounts metadata replacement deltas and refuses a growing replacement without losing the old owner", () => {
  const small = observe(1, "/small");
  const large = observe(1, `/large/${"x".repeat(8_192)}`);
  const addition = observe(2);
  expect(large.evidence_id).toBe(small.evidence_id);
  const largeCost = recordCost(large);
  expect(recordCost(small) + recordCost(addition)).toBeLessThan(largeCost);

  const records = new InvestigationRecords({
    maximumRepresentationBytes: largeCost,
  });
  expect(records.recordEvidence(large).ok).toBe(true);
  expect(
    records.mergeEvidenceBundle(
      createImmutableEvidenceBundle([small, addition]),
    ),
  ).toMatchObject({ ok: true, value: { recordsAdded: 1, changed: true } });
  expect(
    records.evidenceForAnalysis(small.evidence_id)?.subject?.local_path,
  ).toBe("/small");
  expect(records.statistics().retainedRepresentationBytes).toBe(
    recordCost(small) + recordCost(addition),
  );
  const before = records.statistics();
  expect(
    records.mergeEvidenceBundle(createImmutableEvidenceBundle([large])).ok,
  ).toBe(false);
  expect(records.statistics()).toEqual(before);
  expect(
    records.evidenceForAnalysis(small.evidence_id)?.subject?.local_path,
  ).toBe("/small");
  expect(records.hasEvidence(addition.evidence_id)).toBe(true);
});

it("admits Evidence, mutation and Unknown together and makes exact creation replay zero-growth", () => {
  const source = observe(1);
  const control = new InvestigationRecords();
  const created = control.recordEvidenceWithUnknown(source, unknownInput);
  if (!created.ok) throw created.error;
  const cost = control.statistics().retainedRepresentationBytes;
  const refused = new InvestigationRecords({
    maximumRepresentationBytes: cost - 1,
  });
  expect(refused.recordEvidenceWithUnknown(source, unknownInput)).toMatchObject(
    {
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError", resource: "capacity" },
    },
  );
  expect(refused.statistics()).toMatchObject({
    evidenceRecords: 0,
    unknownRevisions: 0,
    unknownHeads: 0,
    retainedRepresentationBytes: 0,
  });

  const records = new InvestigationRecords({
    maximumRepresentationBytes: cost,
  });
  expect(records.recordEvidenceWithUnknown(source, unknownInput).ok).toBe(true);
  const before = records.statistics();
  expect(records.recordEvidenceWithUnknown(source, unknownInput)).toEqual({
    ok: true,
    value: null,
  });
  expect(records.statistics()).toEqual(before);
  expect(records.statistics()).toMatchObject({
    evidenceRecords: 2,
    unknownRevisions: 1,
    unknownHeads: 1,
  });
});

it("preserves the current Unknown revision and mutation history when an update exceeds capacity", () => {
  const control = new InvestigationRecords();
  const created = control.recordUnknown(unknownInput);
  if (!created.ok) throw created.error;
  const base = control.immutableEvidenceBundle();
  const maximum = control.statistics().retainedRepresentationBytes;
  const records = new InvestigationRecords({
    maximumRepresentationBytes: maximum,
  });
  expect(records.mergeEvidenceBundle(base).ok).toBe(true);
  const before = records.statistics();
  expect(records.updateUnknown(updateInput(created.value))).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "capacity" },
  });
  expect(records.statistics()).toEqual(before);
  expect(records.listUnknowns()).toEqual([created.value]);
  expect(records.exportEvidenceBundle()).toEqual(base);

  const updated = control.updateUnknown(updateInput(created.value));
  if (!updated.ok) throw updated.error;
  expect(control.statistics()).toMatchObject({
    unknownRevisions: 2,
    unknownHeads: 1,
  });
  expect(
    records.mergeEvidenceBundle(control.immutableEvidenceBundle()).ok,
  ).toBe(false);
  expect(records.statistics()).toEqual(before);
  expect(records.exportEvidenceBundle()).toEqual(base);
});

it("rejects metadata growth atomically even when the import also carries existing Unknown history", () => {
  const source = observe(1, "/small");
  const control = new InvestigationRecords();
  expect(control.recordEvidenceWithUnknown(source, unknownInput).ok).toBe(true);
  const base = control.immutableEvidenceBundle();
  const records = new InvestigationRecords({
    maximumRepresentationBytes:
      control.statistics().retainedRepresentationBytes,
  });
  expect(records.mergeEvidenceBundle(base).ok).toBe(true);
  const enlarged = observe(1, `/large/${"x".repeat(4_096)}`);
  const replacement = createImmutableEvidenceBundle(
    base.records.map((record) =>
      record.evidence_id === source.evidence_id ? enlarged : record,
    ),
    base.unknowns,
  );
  const before = records.statistics();
  expect(records.mergeEvidenceBundle(replacement).ok).toBe(false);
  expect(records.statistics()).toEqual(before);
  expect(records.exportEvidenceBundle()).toEqual(base);
});

it("borrows authenticated immutable inputs without budgeting nonexistent authentication clones", () => {
  const first = observe(1);
  const second = observe(2);
  const records = new InvestigationRecords({
    availableAuthenticationBytes: () => 0,
  });
  expect(records.recordEvidence(first).ok).toBe(true);
  const bundle = createImmutableEvidenceBundle([first, second]);
  expect(isImmutableEvidenceBundle(bundle)).toBe(true);
  expect(
    isImmutableEvidenceBundle(Object.freeze(createEvidenceBundle([first]))),
  ).toBe(false);
  expect(records.mergeEvidenceBundle(bundle).ok).toBe(true);
  const before = records.statistics();
  expect(records.mergeEvidenceBundle(bundle)).toMatchObject({
    ok: true,
    value: { recordsAdded: 0, unknownsAdded: 0, changed: false },
  });
  expect(records.statistics()).toEqual(before);
  expect(records.recordEvidence(structuredClone(first))).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(records.mergeEvidenceBundle(structuredClone(bundle))).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(records.statistics()).toEqual(before);
});

it("reads statistics without asking either bundle-export path to copy retained facts", () => {
  const records = new InvestigationRecords();
  expect(records.recordEvidence(observe(1)).ok).toBe(true);
  const detached = vi
    .spyOn(records, "exportEvidenceBundle")
    .mockImplementation(() => {
      throw new Error("Statistics must not export a detached bundle");
    });
  const borrowed = vi
    .spyOn(records, "immutableEvidenceBundle")
    .mockImplementation(() => {
      throw new Error("Statistics must not construct a borrowed bundle");
    });
  expect(records.statistics()).toMatchObject({
    evidenceRecords: 1,
    unknownHeads: 0,
  });
  expect(detached).not.toHaveBeenCalled();
  expect(borrowed).not.toHaveBeenCalled();
});
