import { describe, expect, it } from "vitest";

import {
  ANALYSIS_SNAPSHOT_TARGET as target,
  ANALYSIS_SNAPSHOT_PROVIDER as provider,
} from "../../domain/analysisSnapshot.fixture.js";
import { createEvidence } from "../../domain/evidence.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import {
  recordUnknownInputSchema,
  updateUnknownInputSchema,
} from "../../domain/residualUnknown.js";
import { unknownMutationEvidence } from "./UnknownEvidence.js";
import { InvestigationRecords } from "./InvestigationRecords.js";

const unknownInput = (question: string) =>
  recordUnknownInputSchema.parse({
    question,
    severity: "medium",
    domain: "investigation",
    required_authority: "analyst-inference",
    required_confidence: "derived",
    required_environment: null,
    recommended_probes: [],
    relationships: [],
  });
const evidence = createEvidence(undefined, provider, {
  operation: "inspect-fixture",
  parameters: {},
  result: true,
  confidence: "derived",
  authority: "analyst-inference",
});

describe("investigation record ownership", () => {
  it("keeps identity, detached reads and independent stores without a binary target", () => {
    const records = new InvestigationRecords();
    expect(records.recordEvidence(evidence)).toEqual({
      ok: true,
      value: "added",
    });
    expect(records.recordEvidence(evidence)).toEqual({
      ok: true,
      value: "duplicate",
    });
    const read = records.evidenceById(evidence.evidence_id);
    if (read === undefined) throw new Error("Missing recorded Evidence");
    Reflect.set(read, "operation", "forged");
    expect(records.evidenceById(evidence.evidence_id)).toEqual(evidence);
    expect(new InvestigationRecords().hasEvidence(evidence.evidence_id)).toBe(
      false,
    );
  });

  it("preserves explicit Unknown subjects and target-free atomic mutation subjects", () => {
    const records = new InvestigationRecords();
    const input = unknownInput("Which target supplies this observation?");
    const bound = records.recordUnknown(input, target);
    expect(bound).toMatchObject({
      ok: true,
      value: {
        scope_digest: target.sha256,
        mutation_evidence_ids: [
          unknownMutationEvidence(target, input).evidence_id,
        ],
      },
    });
    const independent = records.recordEvidenceWithUnknown(evidence, input);
    expect(independent).toMatchObject({
      ok: true,
      value: {
        scope_digest: null,
        mutation_evidence_ids: [
          unknownMutationEvidence(undefined, input).evidence_id,
        ],
      },
    });
    const mutation = records.evidenceById(
      unknownMutationEvidence(undefined, input).evidence_id,
    );
    expect(mutation?.subject).toBeNull();
    expect(records.listUnknowns()).toHaveLength(2);
  });

  it("rolls back Evidence when the linked Unknown fails validation", () => {
    const records = new InvestigationRecords();
    const invalid = {
      ...unknownInput("Is the missing Evidence present?"),
      supporting_evidence_ids: [`ev_${"f".repeat(64)}`],
    };
    expect(records.recordEvidenceWithUnknown(evidence, invalid).ok).toBe(false);
    expect(records.hasEvidence(evidence.evidence_id)).toBe(false);
    expect(records.exportEvidenceBundle()).toEqual(createEvidenceBundle([]));
  });

  it("preserves optimistic revisions and the explicit update subject", () => {
    const records = new InvestigationRecords();
    const created = records.recordUnknown(
      unknownInput("Can this revision be updated?"),
      target,
    );
    if (!created.ok) throw created.error;
    const input = updateUnknownInputSchema.parse({
      unknown_id: created.value.unknown_id,
      expected_revision: created.value.revision,
      status: "investigating",
      severity: created.value.severity,
      supporting_evidence_ids: created.value.supporting_evidence_ids,
      contradicting_evidence_ids: created.value.contradicting_evidence_ids,
      required_authority: created.value.required_authority,
      required_confidence: created.value.required_confidence,
      required_environment: created.value.required_environment,
      recommended_probes: created.value.recommended_probes,
      relationships: created.value.relationships,
      resolution: created.value.resolution,
    });
    const updated = records.updateUnknown(input, target);
    expect(updated).toMatchObject({
      ok: true,
      value: { revision: 2, scope_digest: target.sha256 },
    });
    const bundle = records.exportEvidenceBundle();
    expect(
      bundle.records.find(({ operation }) => operation === "update_unknown")
        ?.subject?.digest.sha256,
    ).toBe(target.sha256);
    expect(records.updateUnknown(input, target).ok).toBe(false);
    expect(records.exportEvidenceBundle()).toEqual(bundle);
  });

  it("reports Unknown-only bundle changes and clears the single record owner", () => {
    const source = new InvestigationRecords();
    expect(
      source.recordUnknown(
        unknownInput("Can imported Unknowns notify observers?"),
      ).ok,
    ).toBe(true);
    const bundle = source.exportEvidenceBundle();
    const records = new InvestigationRecords();
    expect(
      records.mergeEvidenceBundle(createEvidenceBundle(bundle.records)).ok,
    ).toBe(true);
    expect(records.mergeEvidenceBundle(bundle)).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 1,
        changed: true,
        metadataChanged: false,
      },
    });
    expect(records.mergeEvidenceBundle(bundle)).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: false,
        metadataChanged: false,
      },
    });
    records.clear();
    expect(records.exportEvidenceBundle()).toEqual(createEvidenceBundle([]));
  });
});
