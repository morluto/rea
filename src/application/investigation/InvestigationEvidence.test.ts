import { expect, it } from "vitest";

import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { analysisErrorProjectionSchema } from "../../contracts/errorSchemas.js";
import { InvestigationRecords } from "./InvestigationRecords.js";
import {
  createInvestigationEvidenceClosureChecker,
  resolveInvestigationEvidenceClosure,
} from "./InvestigationEvidence.js";

const observation = (path: string, links: readonly string[] = []): Evidence =>
  createEvidence(
    { path, sha256: "a".repeat(64), format: "elf" },
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "observe",
      parameters: {},
      result: { value: "observed" },
      evidenceLinks: [...links],
    },
  );

it("reads current immutable metadata while preserving earlier snapshots", () => {
  const records = new InvestigationRecords();
  const first = observation("/original");
  const added = records.recordEvidence(first);
  if (!added.ok) throw added.error;
  const lookup = records.evidenceForAnalysis.bind(records);
  const snapshot = records.immutableEvidenceBundle();
  const replacement = observation("/moved");
  expect(replacement.evidence_id).toBe(first.evidence_id);
  const merged = records.mergeEvidenceBundle(
    createEvidenceBundle([replacement]),
  );
  if (!merged.ok) throw merged.error;
  expect(merged.value.replacements).toEqual([
    { kind: "metadata", previous: first, current: replacement },
  ]);
  expect(lookup(first.evidence_id)?.subject?.local_path).toBe("/moved");
  expect(
    records.immutableEvidenceBundle().records[0]?.subject?.local_path,
  ).toBe("/moved");
  expect(snapshot.records[0]?.subject?.local_path).toBe("/original");
  expect(Object.isFrozen(snapshot.records[0]?.subject)).toBe(true);
  records.clear();
  expect(lookup(first.evidence_id)).toBeUndefined();
  expect(records.immutableEvidenceBundle().records).toEqual([]);
  expect(snapshot.records).toHaveLength(1);
});

it("keeps a selected transitive closure distinct from unrelated records and rejects a missing dependency", () => {
  const records = new InvestigationRecords();
  const leaf = observation("/leaf");
  const middle = observation("/middle", [leaf.evidence_id]);
  const root = observation("/root", [middle.evidence_id, leaf.evidence_id]);
  const unrelated = observation("/unrelated", [root.evidence_id]);
  for (const record of [leaf, middle, root, unrelated]) {
    const added = records.recordEvidence(record);
    if (!added.ok) throw added.error;
  }
  expect(
    resolveInvestigationEvidenceClosure(records, [root.evidence_id]),
  ).toEqual({
    ok: true,
    value: [leaf.evidence_id, middle.evidence_id, root.evidence_id].sort(),
  });
  records.clear();
  const added = records.recordEvidence(root);
  if (!added.ok) throw added.error;
  const missing = resolveInvestigationEvidenceClosure(records, [
    root.evidence_id,
  ]);
  expect(missing).toMatchObject({
    ok: false,
    error: {
      _tag: "EvidenceIntegrityError",
      reason: "missing",
      referenceScope: "retained-closure",
    },
  });
  if (missing.ok) throw new Error("missing source closure was resolved");
  const projected = projectAnalysisError(missing.error);
  expect(projected).toMatchObject({
    details: {
      evidence_id: leaf.evidence_id,
      reference_scope: "retained-closure",
      reason: "missing",
    },
  });
  expect(projected.message).toContain(leaf.evidence_id);
  expect(analysisErrorProjectionSchema.parse(projected)).toEqual(projected);
});

it("rejects a lookup that returns another semantic Evidence identity", () => {
  const record = observation("/source");
  const selectedId = `ev_${"0".repeat(64)}`;
  expect(
    resolveInvestigationEvidenceClosure({ evidenceForAnalysis: () => record }, [
      selectedId,
    ]),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "EvidenceIntegrityError",
      reason: "identity_mismatch",
      evidenceId: selectedId,
      actual: record.evidence_id,
      referenceScope: undefined,
    },
  });
});

it("resolves an authenticated source with a wide repeated-link array", () => {
  const leaf = observation("/wide-leaf");
  const source = observation(
    "/wide-source",
    Array(500_000).fill(leaf.evidence_id),
  );
  expect(source.evidence_links).toHaveLength(500_000);
  const records = new InvestigationRecords();
  for (const record of [leaf, source]) {
    const added = records.recordEvidence(record);
    if (!added.ok) throw added.error;
  }
  expect(
    records.evidenceForAnalysis(source.evidence_id)?.evidence_links,
  ).toHaveLength(500_000);
  expect(
    resolveInvestigationEvidenceClosure(records, [source.evidence_id]),
  ).toEqual({
    ok: true,
    value: [source.evidence_id, leaf.evidence_id].sort(),
  });
});

it("reuses a complete shared source graph without weakening missing-source checks", () => {
  const leaf = observation("/shared-leaf");
  const source = observation("/shared-source", [leaf.evidence_id]);
  const records = new Map(
    [leaf, source].map((record) => [record.evidence_id, record]),
  );
  let lookups = 0;
  const check = createInvestigationEvidenceClosureChecker({
    evidenceForAnalysis: (id) => {
      lookups++;
      return records.get(id);
    },
  });
  expect(check([source.evidence_id])).toBe(true);
  expect(lookups).toBe(2);
  expect(check([source.evidence_id, leaf.evidence_id])).toBe(true);
  expect(lookups).toBe(2);
  const missing = `ev_${"0".repeat(64)}`;
  expect(check([missing])).toBe(false);
  expect(check([missing])).toBe(false);
  expect(lookups).toBe(3);
  expect(check([source.evidence_id, missing])).toBe(false);
});
