import { describe, expect, it } from "vitest";

import type { BinaryTarget } from "../../domain/binaryTarget.js";
import { createEvidence } from "../../domain/evidence.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import { recordUnknownInputSchema } from "../../domain/residualUnknown.js";
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
  it("deduplicates and atomically imports bundles", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    const ledger = new EvidenceLedger();
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
      value: { recordsAdded: 0, unknownsAdded: 0, changed: false },
    });
    ledger.clear();
    expect(ledger.export().records).toEqual([]);
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

  it("retains inline evidence larger than the former session byte quota", () => {
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
  it("rejects conflicting duplicate IDs without mutating the ledger", () => {
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

  it("atomically rejects Evidence plus an invalid unknown", () => {
    const ledger = new EvidenceLedger();
    const output = createEvidence(undefined, PROVIDER, {
      operation: "derived",
      parameters: {},
      result: { status: "unknown" },
    });
    const mutation = createEvidence(undefined, PROVIDER, {
      predicateType: "rea.residual-unknown-mutation",
      operation: "record_unknown",
      parameters: {},
      result: { action: "record" },
    });
    const unknown = recordUnknownInputSchema.parse({
      approved: true,
      question: "What remains unresolved?",
      severity: "high",
      domain: "atomic-test",
      supporting_evidence_ids: [`ev_${"f".repeat(64)}`],
      contradicting_evidence_ids: [],
      required_authority: "shipped-artifact",
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [],
      relationships: [],
    });
    expect(ledger.recordWithUnknown(output, unknown, mutation)).toMatchObject({
      ok: false,
      error: { _tag: "UnknownRegistryError" },
    });
    expect(ledger.export()).toMatchObject({ records: [], unknowns: [] });
  });
});
