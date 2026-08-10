import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { createAnalysisProfile } from "./analysisProfile.js";
import type { BinaryTarget } from "./binaryTarget.js";
import { createEvidence, evidenceSchema, parseEvidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";

const TARGET: BinaryTarget = {
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["arm64"],
};
const PROVIDER = { id: "fixture", name: "Fixture provider", version: "1" };
const PROFILE = createAnalysisProfile(PROVIDER, 1, { loader: "default" });

describe("analysis evidence identity", () => {
  it("normalizes prototype-named parameter keys", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: Object.fromEntries([["__proto__", false]]),
      result: true,
    });
    expect(parseEvidence(evidence)).toEqual(evidence);
  });

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

  it("creates deterministic provider-neutral Evidence v2", () => {
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

  it("preserves legacy records while binding profiled Evidence to its profile", () => {
    const legacy = createEvidence(TARGET, PROVIDER, {
      operation: "procedure_info",
      parameters: { procedure: "main" },
      result: { name: "main" },
    });
    expect(parseEvidence(legacy)).toEqual(legacy);

    const profiled = createEvidence(TARGET, PROVIDER, {
      operation: "procedure_info",
      parameters: { procedure: "main" },
      result: { name: "main" },
      analysisProfile: PROFILE,
    });
    expect(profiled).toMatchObject({ analysis_profile: PROFILE });
    expect(profiled.evidence_id).not.toBe(legacy.evidence_id);
    expect(() =>
      createEvidence(
        TARGET,
        { ...PROVIDER, id: "other" },
        {
          operation: "procedure_info",
          parameters: {},
          result: null,
          analysisProfile: PROFILE,
        },
      ),
    ).toThrow(/profile provider/u);
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
    expect(
      createEvidence(TARGET, PROVIDER, {
        ...observation,
        rawResult: { pid: 200 },
      }).evidence_id,
    ).not.toBe(first.evidence_id);
  });

  it("rejects semantic tampering and obsolete schema versions", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    expect(() =>
      parseEvidence({ ...evidence, normalized_result: false }),
    ).toThrow("semantic identifier");
    expect(() => parseEvidence({ schema_version: 1 })).toThrow(
      "Evidence v1 is not accepted. Produce Evidence v2.",
    );
  });
});

it("derives byte-stable bundle manifests independent of record order", () => {
  const artifactEvidence = createEvidence(TARGET, PROVIDER, {
    operation: "health",
    parameters: {},
    result: true,
  });
  const captureEvidence = createEvidence(
    undefined,
    { id: "process", name: "Process capture", version: "1" },
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
