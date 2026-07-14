import { describe, expect, it } from "vitest";

import { EvidenceLedger } from "../src/application/EvidenceLedger.js";
import { createEvidence } from "../src/domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
  serializeEvidenceBundle,
} from "../src/domain/evidenceBundle.js";
import {
  createResidualUnknown,
  recordUnknownInputSchema,
  updateUnknownInputSchema,
  type RecordUnknownInput,
  type ResidualUnknown,
} from "../src/domain/residualUnknown.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };
const ledger = (): EvidenceLedger =>
  new EvidenceLedger({ maxRecords: 1_000, maxBytes: 4 * 1024 * 1024 });
const evidence = (
  label: string,
  confidence: "observed" | "derived" | "inferred" = "derived",
) =>
  createEvidence(undefined, provider, {
    operation: label,
    parameters: {},
    result: { label },
    confidence,
    authority:
      confidence === "observed" ? "controlled-replay" : "analyst-inference",
    environment:
      confidence === "observed"
        ? {
            id: "fixture-linux",
            platform: "linux",
            architecture: "x86_64",
            isolation: "process",
          }
        : null,
  });
const input = (
  question: string,
  overrides: Partial<RecordUnknownInput> = {},
): RecordUnknownInput =>
  recordUnknownInputSchema.parse({
    approved: true,
    question,
    severity: "high",
    domain: "protocol",
    required_authority: "controlled-replay",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [],
    relationships: [],
    ...overrides,
  });
const mutation = (label: string) => evidence(`mutation-${label}`);
const update = (
  unknown: ResidualUnknown,
  overrides: Readonly<Record<string, unknown>> = {},
) =>
  updateUnknownInputSchema.parse({
    approved: true,
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
    resolution: null,
    ...overrides,
  });

describe("residual unknown registry", () => {
  it("returns detached unknowns and evidence bundles from every read surface", () => {
    const store = ledger();
    expect(store.record(evidence("detached-record")).ok).toBe(true);
    const created = store.recordUnknown(
      input("Does detached state remain intact?"),
      mutation("detached-unknown"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    Reflect.set(created.value, "status", "resolved");
    const listed = store.listUnknowns();
    expect(listed[0]?.status).toBe("open");
    if (listed[0] !== undefined) Reflect.set(listed[0], "status", "resolved");
    const verified = store.verifyUnknownResolution(created.value.unknown_id);
    expect(verified).toMatchObject({ ok: true, value: { valid: false } });
    if (verified.ok) Reflect.set(verified.value.unknown, "status", "resolved");

    const exported = store.export();
    const exportedRecord = exported.records.find(
      ({ operation }) => operation === "detached-record",
    );
    if (exportedRecord !== undefined)
      Reflect.set(exportedRecord, "operation", "forged");
    expect(store.export().records.map(({ operation }) => operation)).toContain(
      "detached-record",
    );
    expect(
      store.verifyUnknownResolution(created.value.unknown_id),
    ).toMatchObject({ ok: true, value: { valid: false } });
  });

  it("requires approval, derives stable IDs, filters heads, and rejects duplicate creation", () => {
    expect(() =>
      recordUnknownInputSchema.parse({
        ...input("Is branch live?"),
        approved: false,
      }),
    ).toThrow();
    const store = ledger();
    const first = store.recordUnknown(
      input("  Is branch live?  "),
      mutation("one"),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.unknown_id).toMatch(/^unk_[a-f0-9]{64}$/u);
    expect(first.value.revision).toBe(1);
    expect(store.listUnknowns({ severity: "high" })).toHaveLength(1);
    expect(store.listUnknowns({ status: "resolved" })).toEqual([]);
    const duplicate = store.recordUnknown(
      input("Is branch live?"),
      mutation("two"),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok)
      expect(duplicate.error._tag).toBe("UnknownRegistryError");
    const mutationId = `ev_${"a".repeat(64)}`;
    const normalized = createResidualUnknown(
      input("A   scoped question"),
      mutationId,
      "0".repeat(64),
    );
    expect(
      createResidualUnknown(
        input("A scoped question"),
        mutationId,
        "0".repeat(64),
      ).unknown_id,
    ).toBe(normalized.unknown_id);
    expect(
      createResidualUnknown(
        input("A scoped question"),
        mutationId,
        "1".repeat(64),
      ).unknown_id,
    ).not.toBe(normalized.unknown_id);
  });

  it("uses immutable CAS revisions and rejects a stale concurrent writer atomically", () => {
    const store = ledger();
    const created = store.recordUnknown(
      input("Which codec wins?"),
      mutation("create"),
    );
    if (!created.ok) throw created.error;
    const command = update(created.value);
    const winner = store.updateUnknown(command, mutation("winner"));
    expect(winner.ok).toBe(true);
    const loser = store.updateUnknown(command, mutation("loser"));
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.error.message).toContain("revision-conflict");
    expect(store.export().unknowns.map(({ revision }) => revision)).toEqual([
      1, 2,
    ]);
  });

  it("rejects inference for observed resolution, then accepts matching live evidence", () => {
    const store = ledger();
    const inferred = evidence("inference", "inferred");
    expect(store.record(inferred).ok).toBe(true);
    const created = store.recordUnknown(
      input("Does replay confirm response?", {
        supporting_evidence_ids: [inferred.evidence_id],
        required_environment: {
          id: "fixture-linux",
          platform: "linux",
          architecture: "x86_64",
          isolation: "process",
        },
      }),
      mutation("create-resolution"),
    );
    if (!created.ok) throw created.error;
    const invalid = store.updateUnknown(
      update(created.value, {
        status: "resolved",
        resolution: {
          disposition: "verified",
          rationale: "Inference alone is insufficient.",
          evidence_ids: [inferred.evidence_id],
        },
      }),
      mutation("invalid-resolution"),
    );
    expect(invalid.ok).toBe(false);
    expect(store.listUnknowns()[0]?.revision).toBe(1);

    const observed = evidence("replay", "observed");
    expect(store.record(observed).ok).toBe(true);
    const valid = store.updateUnknown(
      update(created.value, {
        status: "resolved",
        supporting_evidence_ids: [inferred.evidence_id, observed.evidence_id],
        resolution: {
          disposition: "verified",
          rationale: "Controlled replay directly observed response.",
          evidence_ids: [observed.evidence_id],
        },
      }),
      mutation("valid-resolution"),
    );
    expect(valid.ok).toBe(true);
    if (valid.ok)
      expect(store.verifyUnknownResolution(valid.value.unknown_id)).toEqual({
        ok: true,
        value: { valid: true, truthVerified: true, unknown: valid.value },
      });
  });

  it("rejects broken references, dependency cycles, deletion, and tampering", () => {
    const store = ledger();
    const first = store.recordUnknown(input("First?"), mutation("first"));
    if (!first.ok) throw first.error;
    const second = store.recordUnknown(
      input("Second?", {
        relationships: [
          { type: "depends-on", unknown_id: first.value.unknown_id },
        ],
      }),
      mutation("second"),
    );
    if (!second.ok) throw second.error;
    const cycle = store.updateUnknown(
      update(first.value, {
        relationships: [
          { type: "depends-on", unknown_id: second.value.unknown_id },
        ],
      }),
      mutation("cycle"),
    );
    expect(cycle.ok).toBe(false);

    const bundle = store.export();
    expect(parseEvidenceBundle(bundle)).toEqual(bundle);
    expect(serializeEvidenceBundle(bundle)).toBe(
      serializeEvidenceBundle(
        createEvidenceBundle(
          [...bundle.records].reverse(),
          [...bundle.unknowns].reverse(),
        ),
      ),
    );
    expect(() =>
      parseEvidenceBundle({ ...bundle, records: bundle.records.slice(1) }),
    ).toThrow(/missing evidence/u);
    expect(() =>
      parseEvidenceBundle({
        ...bundle,
        unknowns: bundle.unknowns.map((unknown, index) =>
          index === 0 ? { ...unknown, question: "tampered" } : unknown,
        ),
      }),
    ).toThrow();
  });

  it("merges independent histories commutatively and rejects divergent heads atomically", () => {
    const left = ledger();
    const right = ledger();
    expect(left.recordUnknown(input("Left?"), mutation("left")).ok).toBe(true);
    expect(right.recordUnknown(input("Right?"), mutation("right")).ok).toBe(
      true,
    );
    const leftThenRight = ledger();
    const rightThenLeft = ledger();
    expect(leftThenRight.import(left.export()).ok).toBe(true);
    expect(leftThenRight.import(right.export()).ok).toBe(true);
    expect(rightThenLeft.import(right.export()).ok).toBe(true);
    expect(rightThenLeft.import(left.export()).ok).toBe(true);
    expect(serializeEvidenceBundle(leftThenRight.export())).toBe(
      serializeEvidenceBundle(rightThenLeft.export()),
    );

    const base = ledger();
    const created = base.recordUnknown(input("Divergent?"), mutation("base"));
    if (!created.ok) throw created.error;
    const branch = ledger();
    expect(branch.import(base.export()).ok).toBe(true);
    expect(
      base.updateUnknown(update(created.value), mutation("branch-left")).ok,
    ).toBe(true);
    expect(
      branch.updateUnknown(
        update(created.value, { severity: "critical" }),
        mutation("branch-right"),
      ).ok,
    ).toBe(true);
    const before = serializeEvidenceBundle(base.export());
    expect(base.import(branch.export()).ok).toBe(false);
    expect(serializeEvidenceBundle(base.export())).toBe(before);

    const bounded = new EvidenceLedger({ maxRecords: 1, maxBytes: 1_000_000 });
    expect(
      bounded.recordUnknown(input("Too many?"), mutation("bounded")).ok,
    ).toBe(false);
    expect(bounded.export()).toMatchObject({ records: [], unknowns: [] });
  });
});
