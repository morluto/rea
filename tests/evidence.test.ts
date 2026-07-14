import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { EvidenceLedger } from "../src/application/EvidenceLedger.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import {
  createEvidence,
  evidenceSchema,
  parseEvidence,
} from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import { recordUnknownInputSchema } from "../src/domain/residualUnknown.js";

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
  it.prop([
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 12 }),
      fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
    ),
  ])("canonicalizes parameter key order", (parameters) => {
    const reversed = Object.fromEntries(Object.entries(parameters).reverse());
    const first = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters,
      result: true,
    });
    const second = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: reversed,
      result: true,
    });
    expect(second.evidence_id).toBe(first.evidence_id);
  });

  it.prop([fc.string({ minLength: 1 }), fc.string({ minLength: 1 })])(
    "keeps identity path-independent and provider-sensitive",
    (firstPath, secondPath) => {
      const first = createEvidence(
        { ...TARGET, path: `/first/${firstPath}/artifact` },
        PROVIDER,
        { operation: "health", parameters: {}, result: true },
      );
      const moved = createEvidence(
        { ...TARGET, path: `/second/${secondPath}/artifact` },
        PROVIDER,
        { operation: "health", parameters: {}, result: true },
      );
      const changedProvider = createEvidence(
        { ...TARGET, path: `/second/${secondPath}/artifact` },
        { ...PROVIDER, id: `${PROVIDER.id}-other` },
        { operation: "health", parameters: {}, result: true },
      );
      expect(moved.evidence_id).toBe(first.evidence_id);
      expect(changedProvider.evidence_id).not.toBe(first.evidence_id);
    },
  );

  it("creates provider-neutral, deterministic Evidence v2", () => {
    const observation = {
      operation: "procedure_info",
      parameters: { document: null, procedure: "0x1000" },
      result: { name: "main" },
      rawResult: { token: "<redacted:token>" },
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
      raw_result: { token: "<redacted:token>" },
      normalized_result: { name: "main" },
    });
    expect(evidence.evidence_id).toMatch(/^ev_[a-f0-9]{64}$/u);
    expect(createEvidence(TARGET, PROVIDER, observation)).toEqual(evidence);
  });

  it("excludes local paths but includes redacted raw results in identity", () => {
    const observation = {
      operation: "health",
      parameters: {},
      result: true,
      rawResult: { pid: 100 },
    } as const;
    const first = createEvidence(TARGET, PROVIDER, observation);
    const moved = createEvidence(
      { ...TARGET, path: "/other/renamed-fixture" },
      PROVIDER,
      observation,
    );
    expect(moved.evidence_id).toBe(first.evidence_id);
    const changedRaw = createEvidence(TARGET, PROVIDER, {
      ...observation,
      rawResult: { pid: 200 },
    });
    expect(changedRaw.evidence_id).not.toBe(first.evidence_id);
  });

  it("rejects semantic tampering", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    expect(() =>
      parseEvidence({ ...evidence, normalized_result: false }),
    ).toThrow("semantic identifier");
  });

  it("rejects Evidence v1 with actionable upgrade guidance", () => {
    expect(() => parseEvidence({ schema_version: 1 })).toThrow(
      "Evidence v1 is not accepted. Produce Evidence v2.",
    );
  });

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
      value: 0,
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

  it("derives byte-stable manifests independent of record insertion order", () => {
    const artifactEvidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    const captureEvidence = createEvidence(
      undefined,
      {
        id: "process",
        name: "Process capture",
        version: "1",
      },
      {
        predicateType: "rea.process-capture/v1",
        operation: "capture_process_scenario",
        parameters: {},
        result: { exit: 0 },
        authority: "controlled-replay",
        environment: {
          id: "linux-x64",
          platform: "linux",
          architecture: "x64",
          isolation: "process",
        },
      },
    );
    const forward = createEvidenceBundle([artifactEvidence, captureEvidence]);
    const reverse = createEvidenceBundle([captureEvidence, artifactEvidence]);
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    expect(forward).toMatchObject({
      artifacts: [{ digest: { sha256: TARGET.sha256 }, format: "mach-o" }],
      providers: [{ id: "fixture" }, { id: "process" }],
      environments: [{ id: "linux-x64" }],
      scenarios: [{ evidence_id: captureEvidence.evidence_id }],
      captures: [{ evidence_id: captureEvidence.evidence_id }],
    });
  });

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
