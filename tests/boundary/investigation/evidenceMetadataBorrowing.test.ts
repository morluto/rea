import * as canonicalizeModule from "canonicalize";
import { expect, it, vi } from "vitest";

import { createEvidence } from "../../../src/domain/evidence.js";
import { createImmutableEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { EvidenceLedger } from "../../../src/application/investigation/EvidenceLedger.js";

vi.mock("canonicalize", { spy: true });

it("borrows authenticated same-ID metadata variants without serializing their semantic payloads", () => {
  const observe = (path: string) =>
    createEvidence(
      { path, sha256: "a".repeat(64), format: "file" },
      { id: "fixture", name: "Metadata borrowing fixture", version: "1" },
      {
        operation: "health",
        parameters: {},
        result: { retained: "authored fixture payload" },
      },
      { immutable: true },
    );
  const original = observe("/original/fixture");
  const relocated = observe("/relocated/fixture");
  expect(relocated.evidence_id).toBe(original.evidence_id);
  const incoming = createImmutableEvidenceBundle([relocated]);
  const ledger = new EvidenceLedger({ availableAuthenticationBytes: () => 0 });
  expect(ledger.record(original)).toEqual({ ok: true, value: "added" });
  const before = ledger.statistics();

  // Ingestion already authenticated and sealed both semantic identities. Any
  // canonicalization here recreates the removed payload-sized working strings.
  const serialization = vi
    .spyOn(canonicalizeModule, "default")
    .mockImplementation(() => {
      throw new Error(
        "Authenticated duplicate handling must borrow its payload",
      );
    });
  try {
    expect(ledger.record(relocated)).toEqual({ ok: true, value: "duplicate" });
    expect(ledger.forAnalysis(original.evidence_id)).toBe(original);
    expect(ledger.statistics()).toEqual(before);

    const imported = ledger.import(incoming);
    expect(imported).toMatchObject({
      ok: true,
      value: {
        recordsAdded: 0,
        unknownsAdded: 0,
        changed: true,
        replacements: [
          { kind: "metadata", previous: original, current: relocated },
        ],
      },
    });
    expect(ledger.forAnalysis(original.evidence_id)).toBe(relocated);
    expect(ledger.statistics().evidenceRecords).toBe(1);
    expect(serialization).not.toHaveBeenCalled();
  } finally {
    serialization.mockRestore();
  }
});
