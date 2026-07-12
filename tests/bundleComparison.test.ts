import { describe, expect, it } from "vitest";

import {
  bundleComparisonResultSchema,
  compareBundles,
} from "../src/domain/bundleComparison.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import {
  createResidualUnknown,
  recordUnknownInputSchema,
  updateResidualUnknown,
  updateUnknownInputSchema,
} from "../src/domain/residualUnknown.js";

const PROVIDER = { id: "fixture", name: "Fixture", version: "1" } as const;
const evidence = (label: string) =>
  createEvidence(undefined, PROVIDER, {
    operation: "observe",
    parameters: { label },
    result: { label },
    confidence: "derived",
    authority: "analyst-inference",
  });

describe("bundle comparison", () => {
  it("returns unchanged only for equal canonical bundles", () => {
    const first = evidence("first");
    const second = evidence("second");
    const left = createEvidenceBundle([first, second]);
    const right = createEvidenceBundle([second, first]);
    const result = compareBundles(left, right, [], 0, 100);
    expect(bundleComparisonResultSchema.parse(result)).toMatchObject({
      status: "unchanged",
      summary: {
        records_unchanged: 2,
        records_added: 0,
        records_removed: 0,
        unresolved: 0,
      },
      changes: { total: 0, next_offset: null },
    });
    expect(result.left_bundle_sha256).toBe(result.right_bundle_sha256);
  });

  it("classifies explicit pairs and pages stable membership changes", () => {
    const oldRecord = evidence("old");
    const newRecord = evidence("new");
    const removed = evidence("removed");
    const added = evidence("added");
    const left = createEvidenceBundle([oldRecord, removed]);
    const right = createEvidenceBundle([newRecord, added]);
    const pairs = [
      {
        left_evidence_id: oldRecord.evidence_id,
        right_evidence_id: newRecord.evidence_id,
      },
    ];
    const first = compareBundles(left, right, pairs, 0, 1);
    const repeated = compareBundles(left, right, pairs, 0, 1);
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      status: "changed",
      summary: {
        records_added: 1,
        records_removed: 1,
        records_changed: 1,
      },
      changes: { total: 3, next_offset: 1 },
    });
    expect(
      compareBundles(left, right, pairs, 1, 500).changes.items,
    ).toHaveLength(2);
    expect(first.limitations).toContain(
      "One-sided membership proves only bundle inclusion or omission, not behavioral absence.",
    );
  });

  it("rejects missing and non-bijective explicit pairs", () => {
    const leftRecord = evidence("left");
    const rightRecord = evidence("right");
    const left = createEvidenceBundle([leftRecord]);
    const right = createEvidenceBundle([rightRecord]);
    expect(() =>
      compareBundles(
        left,
        right,
        [
          {
            left_evidence_id: evidence("missing").evidence_id,
            right_evidence_id: rightRecord.evidence_id,
          },
        ],
        0,
        100,
      ),
    ).toThrow(/missing left evidence/u);
    expect(() =>
      compareBundles(
        left,
        right,
        [
          {
            left_evidence_id: leftRecord.evidence_id,
            right_evidence_id: rightRecord.evidence_id,
          },
          {
            left_evidence_id: leftRecord.evidence_id,
            right_evidence_id: rightRecord.evidence_id,
          },
        ],
        0,
        100,
      ),
    ).toThrow(/one-to-one/u);
    expect(() =>
      compareBundles(
        { ...left, records: [leftRecord, leftRecord] },
        right,
        [],
        0,
        100,
      ),
    ).toThrow(/duplicate record IDs/u);
  });

  it("distinguishes advanced and missing unknown histories from equality", () => {
    const mutationOne = evidence("mutation-one");
    const initial = createResidualUnknown(
      recordUnknownInputSchema.parse({
        approved: true,
        question: "Which branch remains unexplained?",
        severity: "high",
        domain: "comparison",
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        required_authority: "shipped-artifact",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
      }),
      mutationOne.evidence_id,
      null,
    );
    const mutationTwo = evidence("mutation-two");
    const advanced = updateResidualUnknown(
      initial,
      updateUnknownInputSchema.parse({
        approved: true,
        unknown_id: initial.unknown_id,
        expected_revision: 1,
        status: "investigating",
        severity: initial.severity,
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        required_authority: initial.required_authority,
        required_confidence: initial.required_confidence,
        required_environment: null,
        recommended_probes: [],
        relationships: [],
        resolution: null,
      }),
      mutationTwo.evidence_id,
    );
    const initialBundle = createEvidenceBundle([mutationOne], [initial]);
    const advancedBundle = createEvidenceBundle(
      [mutationOne, mutationTwo],
      [initial, advanced],
    );
    expect(
      compareBundles(initialBundle, advancedBundle, [], 0, 100),
    ).toMatchObject({
      status: "changed",
      summary: { unknowns_advanced: 1, unresolved: 0 },
      changes: {
        items: [
          expect.objectContaining({
            entity: "evidence",
            classification: "added",
          }),
          expect.objectContaining({
            entity: "residual_unknown",
            classification: "history_advanced",
          }),
        ],
      },
    });
    const absent = createEvidenceBundle([]);
    const missing = compareBundles(initialBundle, absent, [], 0, 100);
    expect(missing).toMatchObject({
      status: "unknown",
      summary: { unknowns_removed: 1, unresolved: 1 },
    });
    expect(missing.changes.items).toContainEqual(
      expect.objectContaining({
        classification: "removed",
        conclusion_kind: "unresolved_branch",
        limitations: [
          "A missing unknown history does not establish resolution.",
        ],
      }),
    );
  });
});
