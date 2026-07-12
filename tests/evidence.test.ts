import { describe, expect, it } from "vitest";

import { EvidenceLedger } from "../src/application/EvidenceLedger.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import {
  createEvidence,
  evidenceSchema,
  parseEvidence,
} from "../src/domain/evidence.js";

const TARGET: BinaryTarget = {
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["arm64"],
  loaderArgs: ["-l", "Mach-O", "--aarch64"],
};
const PROVIDER = { id: "fixture", name: "Fixture provider", version: "1" };

describe("analysis evidence", () => {
  it("creates provider-neutral, deterministic Evidence v2", () => {
    const observation = {
      operation: "procedure_info",
      parameters: { document: null, procedure: "0x1000" },
      result: { name: "main" },
      redactedRawPayload: { token: "<redacted:token>" },
    } as const;
    const evidence = createEvidence(TARGET, PROVIDER, observation);
    expect(evidenceSchema.parse(evidence)).toEqual(evidence);
    expect(parseEvidence(evidence)).toEqual(evidence);
    expect(evidence).toMatchObject({
      schema_version: 2,
      provider: PROVIDER,
      subject: { digest: { sha256: "a".repeat(64) } },
      confidence: "observed",
      authority: "shipped-artifact",
    });
    expect(evidence.evidence_id).toMatch(/^ev_[a-f0-9]{64}$/u);
    expect(evidence.raw_payload_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(createEvidence(TARGET, PROVIDER, observation)).toEqual(evidence);
  });

  it("excludes local paths and redacted raw payloads from semantic identity", () => {
    const observation = {
      operation: "health",
      parameters: {},
      result: true,
      redactedRawPayload: { pid: 100 },
    } as const;
    const first = createEvidence(TARGET, PROVIDER, observation);
    const moved = createEvidence(
      { ...TARGET, path: "/other/renamed-fixture" },
      PROVIDER,
      { ...observation, redactedRawPayload: { pid: 200 } },
    );
    expect(moved.evidence_id).toBe(first.evidence_id);
    expect(moved.raw_payload_sha256).not.toBe(first.raw_payload_sha256);
  });

  it("rejects semantic tampering", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    expect(() => parseEvidence({ ...evidence, result: false })).toThrow(
      "semantic identifier",
    );
  });

  it("deduplicates and atomically imports bounded bundles", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    const ledger = new EvidenceLedger({ maxRecords: 1 });
    expect(ledger.record(evidence)).toBe("added");
    expect(ledger.record(evidence)).toBe("duplicate");
    const relocated = createEvidence(
      { ...TARGET, path: "/relocated/different-name" },
      PROVIDER,
      { operation: "health", parameters: {}, result: true },
    );
    expect(relocated.evidence_id).toBe(evidence.evidence_id);
    expect(ledger.record(relocated)).toBe("duplicate");
    expect(ledger.import({ bundle_version: 1, records: [evidence] })).toBe(0);
    expect(ledger.export().records).toEqual([evidence]);
    ledger.clear();
    expect(ledger.export().records).toEqual([]);
  });

  it("rejects duplicate semantic IDs with conflicting raw payload hashes", () => {
    const ledger = new EvidenceLedger({ maxRecords: 2 });
    const first = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
      redactedRawPayload: { pid: 1 },
    });
    const second = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
      redactedRawPayload: { pid: 2 },
    });
    ledger.record(first);
    expect(() => ledger.record(second)).toThrow("Conflicting evidence");
  });
});
