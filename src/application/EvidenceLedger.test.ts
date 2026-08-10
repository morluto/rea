import { describe, expect, it } from "vitest";

import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence, evidenceSchema } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { recordUnknownInputSchema } from "../domain/residualUnknown.js";
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

describe("evidence ledger recording", () => {
  it("deduplicates and atomically imports bounded bundles", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    const ledger = new EvidenceLedger({ maxRecords: 1, maxBytes: 1_000_000 });
    expect(ledger.record(evidence)).toEqual({ ok: true, value: "added" });
    expect(ledger.record(evidence)).toEqual({ ok: true, value: "duplicate" });
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
      value: { recordsAdded: 0, unknownsAdded: 0, changed: false },
    });
    expect(ledger.export().records).toEqual([evidence]);
    ledger.clear();
    expect(ledger.export().records).toEqual([]);
  });

  it("treats canonical JSON key order as semantically irrelevant", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: { alpha: 1, beta: 2 },
      result: { alpha: 1, beta: 2 },
    });
    const reordered = evidenceSchema.parse({
      ...evidence,
      parameters: { beta: 2, alpha: 1 },
      normalized_result: { beta: 2, alpha: 1 },
    });
    const ledger = new EvidenceLedger({ maxRecords: 1, maxBytes: 1_000_000 });
    expect(ledger.record(evidence)).toEqual({ ok: true, value: "added" });
    expect(ledger.record(reordered)).toEqual({
      ok: true,
      value: "duplicate",
    });
  });

  it("returns typed record and byte limit failures without eviction", () => {
    const first = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    const second = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: { changed: true },
      result: true,
    });
    const recordBound = new EvidenceLedger({
      maxRecords: 1,
      maxBytes: 1_000_000,
    });
    expect(recordBound.record(first).ok).toBe(true);
    expect(recordBound.record(second)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceLimitError", limit: "records", maximum: 1 },
    });
    expect(recordBound.export().records).toEqual([first]);

    const byteBound = new EvidenceLedger({ maxRecords: 10, maxBytes: 1 });
    expect(byteBound.record(first)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceLimitError", limit: "bytes", maximum: 1 },
    });
    expect(byteBound.export().records).toEqual([]);
  });

  it("counts unknown revisions when enforcing direct record limits", () => {
    const ledger = new EvidenceLedger({
      maxRecords: 2,
      maxBytes: 1_000_000,
    });
    const mutation = createEvidence(undefined, PROVIDER, {
      predicateType: "rea.residual-unknown-mutation/v1",
      operation: "record_unknown",
      parameters: {},
      result: { action: "record" },
    });
    const unknown = recordUnknownInputSchema.parse({
      approved: true,
      question: "What remains unresolved?",
      severity: "high",
      domain: "record-limit-test",
      supporting_evidence_ids: [],
      contradicting_evidence_ids: [],
      required_authority: "shipped-artifact",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [],
      relationships: [],
    });
    expect(ledger.recordUnknown(unknown, mutation).ok).toBe(true);

    const direct = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    expect(ledger.record(direct)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceLimitError", limit: "records", maximum: 2 },
    });
    expect(ledger.export()).toMatchObject({
      records: [mutation],
      unknowns: [expect.objectContaining({ domain: "record-limit-test" })],
    });
  });
});

describe("evidence bundle imports", () => {
  it("rejects conflicting duplicate IDs without mutating the ledger", () => {
    const ledger = new EvidenceLedger({ maxRecords: 2, maxBytes: 1_000_000 });
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

  it("atomically rejects Evidence plus unknown when the batch exceeds limits", () => {
    const ledger = new EvidenceLedger({ maxRecords: 2, maxBytes: 1_000_000 });
    const output = createEvidence(undefined, PROVIDER, {
      operation: "derived",
      parameters: {},
      result: { status: "unknown" },
    });
    const mutation = createEvidence(undefined, PROVIDER, {
      predicateType: "rea.residual-unknown-mutation/v1",
      operation: "record_unknown",
      parameters: {},
      result: { action: "record" },
    });
    const unknown = recordUnknownInputSchema.parse({
      approved: true,
      question: "What remains unresolved?",
      severity: "high",
      domain: "atomic-test",
      supporting_evidence_ids: [],
      contradicting_evidence_ids: [],
      required_authority: "shipped-artifact",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [],
      relationships: [],
    });
    expect(ledger.recordWithUnknown(output, unknown, mutation)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceLimitError" },
    });
    expect(ledger.export()).toMatchObject({ records: [], unknowns: [] });
  });
});
