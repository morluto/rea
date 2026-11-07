import { describe, expect, it } from "vitest";

import {
  ANALYSIS_SNAPSHOT_TARGET as target,
  ANALYSIS_SNAPSHOT_PROVIDER as provider,
} from "../../domain/analysisSnapshot.fixture.js";
import { createEvidence } from "../../domain/evidence.js";
import {
  createEvidenceBundle,
  redactEvidenceBundle,
  parseEvidenceBundle,
} from "../../domain/evidenceBundle.js";
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
          unknownMutationEvidence(target, {
            operation: "record_unknown",
            input,
          }).evidence_id,
        ],
      },
    });
    const independent = records.recordEvidenceWithUnknown(evidence, input);
    expect(independent).toMatchObject({
      ok: true,
      value: {
        scope_digest: null,
        mutation_evidence_ids: [
          unknownMutationEvidence(undefined, {
            operation: "record_unknown",
            input,
          }).evidence_id,
        ],
      },
    });
    const mutation = records.evidenceById(
      unknownMutationEvidence(undefined, { operation: "record_unknown", input })
        .evidence_id,
    );
    expect(mutation?.subject).toBeNull();
    expect(mutation?.parameters).toEqual(input);
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
    expect(
      bundle.records.find(({ operation }) => operation === "update_unknown")
        ?.parameters,
    ).toEqual(input);
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
        replacements: [],
      },
    });
    expect(records.mergeEvidenceBundle(bundle)).toEqual({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: false,
        replacements: [],
      },
    });
    records.clear();
    expect(records.exportEvidenceBundle()).toEqual(createEvidenceBundle([]));
  });
});

it("retains complete mutation intent and distinguishes independent update requests", () => {
  const source = new InvestigationRecords();
  expect(source.recordEvidence(evidence).ok).toBe(true);
  const input = {
    ...unknownInput("Which replay establishes the answer?"),
    supporting_evidence_ids: [evidence.evidence_id],
    required_environment: {
      id: "fixture",
      platform: "linux",
      architecture: "x86_64",
      isolation: "process" as const,
    },
    recommended_probes: [
      { operation: "inspect_native_api", rationale: "Replay" },
    ],
  };
  const created = source.recordUnknown(input);
  if (!created.ok) throw created.error;
  const base = source.exportEvidenceBundle();
  const creation = base.records.find(
    ({ operation }) => operation === "record_unknown",
  );
  expect(creation?.parameters).toEqual(input);
  expect(creation?.evidence_links).toEqual([evidence.evidence_id]);

  const { question: _question, domain: _domain, ...details } = input;
  const mutations = (["high", "low"] as const).map((severity) => {
    const records = new InvestigationRecords();
    expect(records.mergeEvidenceBundle(base).ok).toBe(true);
    const command = updateUnknownInputSchema.parse({
      ...details,
      unknown_id: created.value.unknown_id,
      expected_revision: 1,
      status: "resolved",
      severity,
      resolution: {
        disposition: "withdrawn",
        rationale: "Caller withdrew this question",
        evidence_ids: [evidence.evidence_id],
      },
    });
    const updated = records.updateUnknown(command);
    if (!updated.ok) throw updated.error;
    const mutation = records
      .exportEvidenceBundle()
      .records.find(({ operation }) => operation === "update_unknown");
    expect(mutation?.parameters).toEqual(command);
    expect(mutation?.evidence_links).toEqual([evidence.evidence_id]);
    expect(updated.value.mutation_evidence_ids).toContain(
      mutation?.evidence_id,
    );
    return mutation;
  });
  expect(mutations[0]?.evidence_id).not.toBe(mutations[1]?.evidence_id);
});

it("rejects changed creation intent after the original unknown was updated", () => {
  const records = new InvestigationRecords();
  const input = unknownInput("Which observation explains this result?");
  const created = records.recordEvidenceWithUnknown(evidence, input);
  if (!created.ok) throw created.error;
  if (created.value === null) throw new Error("Expected a new unknown");
  const { question: _question, domain: _domain, ...details } = input;
  const updated = records.updateUnknown({
    ...details,
    unknown_id: created.value.unknown_id,
    expected_revision: 1,
    status: "investigating",
    severity: "high",
    resolution: null,
  });
  if (!updated.ok) throw updated.error;
  const retained = records.exportEvidenceBundle();
  const addition = createEvidence(undefined, provider, {
    operation: "another-derived-result",
    parameters: {},
    result: true,
    confidence: "derived",
    authority: "analyst-inference",
  });
  for (const result of [evidence, addition]) {
    expect(
      records.recordEvidenceWithUnknown(result, {
        ...input,
        severity: "high",
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "UnknownRegistryError", reason: "already-exists" },
    });
    expect(records.exportEvidenceBundle()).toEqual(retained);
  }
});

it("exports a mapped unknown history with matching mutation identities", () => {
  const records = new InvestigationRecords();
  const input = unknownInput("What happened at /tmp/private/app?");
  const first = records.recordUnknown(input, target);
  if (!first.ok) throw first.error;
  const update = updateUnknownInputSchema.parse({
    unknown_id: first.value.unknown_id,
    expected_revision: 1,
    status: "investigating",
    severity: first.value.severity,
    supporting_evidence_ids: [],
    contradicting_evidence_ids: [],
    required_authority: first.value.required_authority,
    required_confidence: first.value.required_confidence,
    required_environment: null,
    recommended_probes: [],
    relationships: [],
    resolution: null,
  });
  const next = records.updateUnknown(update, target);
  if (!next.ok) throw next.error;
  const mapped = redactEvidenceBundle(
    records.exportEvidenceBundle(),
    "/tmp/private",
  );
  expect(() => parseEvidenceBundle(mapped)).not.toThrow();
  const [created, revised] = mapped.unknowns;
  expect(created?.question).toBe("What happened at $WORKSPACE/app?");
  expect(created?.unknown_id).not.toBe(first.value.unknown_id);
  expect(revised?.unknown_id).toBe(created?.unknown_id);
  expect(revised?.previous_revision_digest).toBe(created?.revision_digest);
  const mutation = mapped.records.find(
    (row) => row.operation === "update_unknown",
  );
  expect(mutation?.parameters.unknown_id).toBe(created?.unknown_id);
  expect(revised?.mutation_evidence_ids).toContain(mutation?.evidence_id);
});

it("rekeys a comparison-scoped unknown and related mutation inputs", () => {
  const records = new InvestigationRecords();
  const comparison = createEvidence(undefined, provider, {
    operation: "compare_functions",
    parameters: {},
    result: { path: "/tmp/private/example" },
  });
  expect(records.recordEvidence(comparison).ok).toBe(true);
  const scopedInput = recordUnknownInputSchema.parse({
    ...unknownInput("Compare /tmp/private/example"),
    domain: "function-comparison",
    comparison_conclusion_scope: {
      comparison_evidence_id: comparison.evidence_id,
      dimensions: ["overall"],
    },
    supporting_evidence_ids: [comparison.evidence_id],
  });
  const scoped = records.recordUnknown(scopedInput, target);
  if (!scoped.ok) throw scoped.error;
  const dependentInput = recordUnknownInputSchema.parse({
    ...unknownInput("Depends on comparison"),
    relationships: [
      { type: "depends-on", unknown_id: scoped.value.unknown_id },
    ],
  });
  const dependent = records.recordUnknown(dependentInput, target);
  if (!dependent.ok) throw dependent.error;
  const mapped = parseEvidenceBundle(
    redactEvidenceBundle(records.exportEvidenceBundle(), "/tmp/private"),
  );
  const newComparison = mapped.records.find(
    (row) => row.operation === "compare_functions",
  )!;
  const newScoped = mapped.unknowns.find(
    (row) => row.domain === "function-comparison",
  )!;
  const newDependent = mapped.unknowns.find(
    (row) => row.domain === "investigation",
  )!;
  expect(newScoped.comparison_conclusion_scope?.comparison_evidence_id).toBe(
    newComparison.evidence_id,
  );
  expect(newScoped.supporting_evidence_ids).toContain(
    newComparison.evidence_id,
  );
  expect(newScoped.unknown_id).not.toBe(scoped.value.unknown_id);
  expect(newDependent.relationships[0]?.unknown_id).toBe(newScoped.unknown_id);
  const mutation = mapped.records.find(
    (row) =>
      row.operation === "record_unknown" &&
      row.parameters.question === "Depends on comparison",
  )!;
  expect(mutation.parameters.relationships).toEqual([
    { type: "depends-on", unknown_id: newScoped.unknown_id },
  ]);
});
