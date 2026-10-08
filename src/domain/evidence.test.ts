import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { createAnalysisProfile } from "./analysisProfile.js";
import type { BinaryTarget } from "./binaryTarget.js";
import {
  createEvidence,
  evidenceRecordSchema,
  evidenceSchema,
  parseEvidence,
} from "./evidence.js";
import { MAX_JSON_DEPTH, type JsonValue } from "./jsonValue.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import { freezeJsonSnapshot } from "./immutableJson.js";

const TARGET: BinaryTarget = {
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["arm64"],
};
const PROVIDER = { id: "fixture", name: "Fixture provider", version: "1" };
const PROFILE = createAnalysisProfile(PROVIDER, { loader: "default" });

it("preserves identity and bytes when reusing an owned immutable result", () => {
  const value = { nested: { values: ["observed", 1] } };
  const mutable = createEvidence(TARGET, PROVIDER, {
    operation: "inspect",
    parameters: {},
    result: value,
  });
  const frozen = createEvidence(TARGET, PROVIDER, {
    operation: "inspect",
    parameters: {},
    result: freezeJsonSnapshot(value),
  });
  expect(JSON.stringify(frozen)).toBe(JSON.stringify(mutable));
  expect(frozen.normalized_result).toBe(value);
  expect(Object.isFrozen(frozen)).toBe(true);
  expect(parseEvidence(frozen)).toEqual(mutable);
  const wire: unknown = JSON.parse(JSON.stringify(frozen));
  expect(parseEvidence(wire)).toEqual(mutable);
  expect(() =>
    parseEvidence({ ...frozen, normalized_result: { changed: true } }),
  ).toThrow("semantic identifier");
});

it("applies the JSON depth boundary to owned immutable results", () => {
  let result: JsonValue = 1;
  for (let index = 0; index <= MAX_JSON_DEPTH; index += 1)
    result = { nested: result };
  const observe = () =>
    createEvidence(TARGET, PROVIDER, {
      operation: "inspect",
      parameters: {},
      result,
    });
  expect(observe).toThrow("maximum nesting depth");
  freezeJsonSnapshot(result);
  expect(observe).toThrow("maximum nesting depth");
});

it("preserves prototype-named own members when reusing an owned result", () => {
  const result = { ["__proto__"]: { preserved: 7 }, constructor: "ordinary" };
  const observation = { operation: "inspect", parameters: {}, result };
  const ordinary = createEvidence(TARGET, PROVIDER, observation);
  const owned = createEvidence(TARGET, PROVIDER, {
    ...observation,
    result: freezeJsonSnapshot(result),
  });
  expect(owned.normalized_result).toBe(result);
  expect(owned).toEqual(ordinary);
  expect(parseEvidence(JSON.parse(JSON.stringify(owned)))).toEqual(owned);
  expect(Object.getPrototypeOf(owned.normalized_result)).toBe(Object.prototype);
  expect(Reflect.get(Object.prototype, "preserved")).toBeUndefined();
});

it("preserves producer envelope admission and profile validation", () => {
  const legacy = createEvidence(TARGET, PROVIDER, {
    operation: "inspect",
    parameters: {},
    result: { observed: [1, 2, 3] },
  });
  const profiled = createEvidence(TARGET, PROVIDER, {
    operation: "inspect",
    parameters: {},
    result: { observed: [1, 2, 3] },
    analysisProfile: PROFILE,
  });
  const candidates: unknown[] = [
    legacy,
    profiled,
    { ...legacy, analysis_profile: undefined },
    { ...legacy, analysis_profile: null },
    {
      ...profiled,
      analysis_profile: { ...PROFILE, provider: { ...PROVIDER, id: "other" } },
    },
    { ...legacy, unexpected: true },
  ];
  for (const candidate of candidates) {
    const canonical = evidenceRecordSchema.safeParse(candidate);
    if (canonical.success)
      expect(parseEvidence(candidate)).toEqual(canonical.data);
    else expect(() => parseEvidence(candidate)).toThrow();
  }
});

it("snapshots caller-owned payloads before deriving their identity", () => {
  const result = { nested: { values: ["observed"] } };
  const rawResult = { entries: [{ value: "raw" }] };
  const parameters = { selected: ["target"] };
  const evidence = createEvidence(TARGET, PROVIDER, {
    operation: "inspect",
    parameters,
    result,
    rawResult,
  });
  result.nested.values.push("later");
  const rawEntry = rawResult.entries[0];
  if (rawEntry !== undefined) rawEntry.value = "changed";
  parameters.selected.push("other");
  expect(evidence.normalized_result).toEqual({
    nested: { values: ["observed"] },
  });
  expect(evidence.raw_result).toEqual({ entries: [{ value: "raw" }] });
  expect(evidence.parameters).toEqual({ selected: ["target"] });
  expect(parseEvidence(evidence)).toEqual(evidence);
  expect(() =>
    parseEvidence({ ...evidence, normalized_result: result }),
  ).toThrow(/semantic identifier/u);
});

describe("analysis evidence identity", () => {
  it("preserves prototype-named parameter keys and their semantic identity", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: Object.fromEntries([["__proto__", false]]),
      result: true,
    });
    expect(evidence.parameters).toEqual({ ["__proto__"]: false });
    expect(Object.hasOwn(evidence.parameters, "__proto__")).toBe(true);
    expect(parseEvidence(evidence)).toEqual(evidence);
    const stripped = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    expect(stripped.evidence_id).not.toBe(evidence.evidence_id);
    expect(() =>
      parseEvidence({
        ...evidence,
        parameters: { ["__proto__"]: true },
      }),
    ).toThrow(/semantic identifier/u);
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

  it("creates deterministic provider-neutral Evidence", () => {
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
});

it("binds an explicit unknown-subject reason into the semantic Evidence identity", () => {
  const reason = "Caller excluded the observed digest.";
  const observation = { operation: "health", parameters: {}, result: true };
  const explicit = createEvidence(undefined, PROVIDER, {
    ...observation,
    subjectUnavailableReason: reason,
  });
  const defaulted = createEvidence(undefined, PROVIDER, observation);
  expect(explicit.subject).toBeNull();
  expect(explicit.limitations).toEqual([reason]);
  expect(defaulted.limitations).toEqual([
    "Artifact identity is unavailable for this observation.",
  ]);
  expect(explicit.evidence_id).not.toBe(defaulted.evidence_id);
  expect(parseEvidence(explicit)).toEqual(explicit);
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
      predicateType: "rea.process-capture",
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

describe("DOS analysis evidence identity", () => {
  it("retains DOS MZ identity independently of PE identity", () => {
    const target = {
      path: TARGET.path,
      sha256: TARGET.sha256,
      kind: "executable" as const,
      format: "dos-mz" as const,
      architecture: "x86" as const,
      availableArchitectures: ["x86" as const],
    };
    const observation = { operation: "health", parameters: {}, result: true };
    const evidence = createEvidence(target, PROVIDER, observation);
    expect(parseEvidence(evidence).subject).toMatchObject({
      format: "dos-mz",
      architecture: "x86",
    });
    expect(evidence.evidence_id).not.toBe(
      createEvidence({ ...target, format: "pe" }, PROVIDER, observation)
        .evidence_id,
    );
  });
});

describe("evidence parameter depth bound", () => {
  it("rejects evidence whose parameters nest past the JSON depth limit", () => {
    const evidence = createEvidence(TARGET, PROVIDER, {
      operation: "health",
      parameters: {},
      result: true,
    });
    let value: unknown = 1;
    for (let index = 0; index <= MAX_JSON_DEPTH; index += 1)
      value = { nested: value };
    const result = evidenceSchema.safeParse({
      ...evidence,
      parameters: { attack: value },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) =>
        issue.message.includes("maximum nesting depth"),
      ),
    ).toBe(true);
  });
});

it("preserves prototype-named raw and normalized results with aligned identity", () => {
  const result = { ["__proto__"]: { preserved: 7 }, constructor: "ordinary" };
  const evidence = createEvidence(TARGET, PROVIDER, {
    operation: "health",
    parameters: {},
    result,
    rawResult: result,
  });
  const parsed = parseEvidence(evidence);
  expect(parsed.normalized_result).toEqual(result);
  expect(parsed.raw_result).toEqual(result);
  expect(Object.getPrototypeOf(parsed.normalized_result)).toBe(
    Object.prototype,
  );
  expect(Reflect.get(Object.prototype, "preserved")).toBeUndefined();
  const stripped = createEvidence(TARGET, PROVIDER, {
    operation: "health",
    parameters: {},
    result: { constructor: "ordinary" },
    rawResult: { constructor: "ordinary" },
  });
  expect(stripped.evidence_id).not.toBe(evidence.evidence_id);
});
