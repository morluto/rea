import { describe, expect, it } from "vitest";
import {
  createEvidence,
  parseEvidence,
  redactEvidence,
  withEvidenceCallerInputPath,
  type EvidenceProvider,
} from "./evidence.js";
import {
  createEvidenceBundle,
  redactEvidenceBundle,
  safeParseEvidenceBundle,
} from "./evidenceBundle.js";

const TEST_PROVIDER: EvidenceProvider = {
  id: "test-provider",
  name: "Test Provider",
  version: "1.0.0",
};

const SHA256 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("opt-in logical path-root redaction across runs", () => {
  it("produces identical evidence_id and passes verification for two different roots", () => {
    // 1. Analyze an identical synthetic fixture located in two different parent directories
    const targetAlpha = {
      path: "/tmp/run-alpha/app/target.bin",
      sha256: SHA256,
      format: "elf" as const,
      architecture: "x86_64" as const,
    };
    const targetBeta = {
      path: "/tmp/run-beta/app/target.bin",
      sha256: SHA256,
      format: "elf" as const,
      architecture: "x86_64" as const,
    };

    const observationAlpha = {
      operation: "inspect_binary_layout",
      parameters: {
        path: "/tmp/run-alpha/app/target.bin",
        binary_path: "/tmp/run-alpha/app/target.bin",
      },
      locations: [
        {
          kind: "artifact-path" as const,
          path: "/tmp/run-alpha/app/target.bin",
        },
      ],
      result: {
        target_location: "/tmp/run-alpha/app/target.bin",
        entry_point: "0x401000",
      },
      rawResult: {
        file: "/tmp/run-alpha/app/target.bin",
      },
      limitations: ["Static section analysis only"],
    };

    const observationBeta = {
      operation: "inspect_binary_layout",
      parameters: {
        path: "/tmp/run-beta/app/target.bin",
        binary_path: "/tmp/run-beta/app/target.bin",
      },
      locations: [
        {
          kind: "artifact-path" as const,
          path: "/tmp/run-beta/app/target.bin",
        },
      ],
      result: {
        target_location: "/tmp/run-beta/app/target.bin",
        entry_point: "0x401000",
      },
      rawResult: {
        file: "/tmp/run-beta/app/target.bin",
      },
      limitations: ["Static section analysis only"],
    };

    const evidenceAlpha = createEvidence(
      targetAlpha,
      TEST_PROVIDER,
      observationAlpha,
      {
        logicalRoot: "/tmp/run-alpha",
        logicalPrefix: "$WORKSPACE",
      },
    );

    const evidenceBeta = createEvidence(
      targetBeta,
      TEST_PROVIDER,
      observationBeta,
      {
        logicalRoot: "/tmp/run-beta",
        logicalPrefix: "$WORKSPACE",
      },
    );

    // 2. Neither output JSON contains run-alpha or run-beta
    const alphaJson = JSON.stringify(evidenceAlpha);
    const betaJson = JSON.stringify(evidenceBeta);

    expect(alphaJson).not.toContain("run-alpha");
    expect(alphaJson).not.toContain("run-beta");
    expect(betaJson).not.toContain("run-alpha");
    expect(betaJson).not.toContain("run-beta");

    // Both contain the logical path
    expect(alphaJson).toContain("$WORKSPACE/app/target.bin");
    expect(betaJson).toContain("$WORKSPACE/app/target.bin");

    // Both pass parseEvidence / authenticatedEvidenceSchema verification
    expect(() => parseEvidence(evidenceAlpha)).not.toThrow();
    expect(() => parseEvidence(evidenceBeta)).not.toThrow();
    expect(() => parseEvidence(JSON.parse(alphaJson))).not.toThrow();
    expect(() => parseEvidence(JSON.parse(betaJson))).not.toThrow();

    // 3. evidence_id matches across both runs
    expect(evidenceAlpha.evidence_id).toBe(evidenceBeta.evidence_id);
    expect(evidenceAlpha.subject?.local_path).toBe("$WORKSPACE/app/target.bin");
    expect(evidenceBeta.subject?.local_path).toBe("$WORKSPACE/app/target.bin");

    // Both have identical semantic records
    expect(evidenceAlpha.parameters).toEqual(evidenceBeta.parameters);
    expect(evidenceAlpha.locations).toEqual(evidenceBeta.locations);
    expect(evidenceAlpha.normalized_result).toEqual(
      evidenceBeta.normalized_result,
    );
    expect(evidenceAlpha.limitations).toEqual(evidenceBeta.limitations);
  });

  it("leaves default local behavior unchanged when path redaction is not requested", () => {
    const target = {
      path: "/local/work/target.bin",
      sha256: SHA256,
      format: "elf" as const,
      architecture: "x86_64" as const,
    };
    const evidence = createEvidence(target, TEST_PROVIDER, {
      operation: "inspect",
      parameters: { path: "/local/work/target.bin" },
      result: { ok: true },
    });

    expect(evidence.subject?.local_path).toBe("/local/work/target.bin");
    expect(evidence.parameters.path).toBe("/local/work/target.bin");
    expect(
      evidence.limitations.some((lim) => lim.includes("normalized relative")),
    ).toBe(false);
  });
});

describe("post-creation redaction of Evidence and bundles", () => {
  it("redacts existing Evidence and re-seals with matching evidence_id", () => {
    const target = {
      path: "/home/alice/project/target.bin",
      sha256: SHA256,
      format: "mach-o" as const,
      architecture: "arm64" as const,
    };
    const original = createEvidence(target, TEST_PROVIDER, {
      operation: "inspect",
      parameters: { path: "/home/alice/project/target.bin" },
      locations: [
        {
          kind: "artifact-path",
          path: "/home/alice/project/target.bin",
        },
      ],
      result: { target_location: "/home/alice/project/target.bin" },
    });

    const redacted = redactEvidence(original, {
      logicalRoot: "/home/alice/project",
      logicalPrefix: "$WORKSPACE",
    });

    expect(redacted.subject?.local_path).toBe("$WORKSPACE/target.bin");
    expect(redacted.parameters.path).toBe("$WORKSPACE/target.bin");
    expect(redacted.locations[0]).toEqual({
      kind: "artifact-path",
      path: "$WORKSPACE/target.bin",
    });
    expect(redacted.evidence_id).not.toBe(original.evidence_id);
    expect(() => parseEvidence(redacted)).not.toThrow();
  });

  it("redacts an entire Evidence bundle while preserving bundle validation", () => {
    const target = {
      path: "/Users/dev/code/binary",
      sha256: SHA256,
      format: "elf" as const,
      architecture: "x86_64" as const,
    };
    const parent = createEvidence(target, TEST_PROVIDER, {
      operation: "open",
      parameters: { path: "/Users/dev/code/binary" },
      result: { status: "opened" },
    });

    const child = createEvidence(target, TEST_PROVIDER, {
      operation: "analyze",
      parameters: { path: "/Users/dev/code/binary" },
      result: { symbols: 42 },
      evidenceLinks: [parent.evidence_id],
    });

    const bundle = createEvidenceBundle([parent, child]);
    const redactedBundle = redactEvidenceBundle(bundle, {
      logicalRoot: "/Users/dev/code",
      logicalPrefix: "$WORKSPACE",
    });

    const bundleJson = JSON.stringify(redactedBundle);
    expect(bundleJson).not.toContain("/Users/dev/code");
    expect(bundleJson).toContain("$WORKSPACE/binary");

    const parsed = safeParseEvidenceBundle(redactedBundle);
    expect(parsed.ok).toBe(true);
  });

  it("redacts caller input path when bound to Evidence", () => {
    const target = {
      path: "/work/app/bin",
      sha256: SHA256,
      format: "elf" as const,
      architecture: "x86_64" as const,
    };
    const evidence = createEvidence(target, TEST_PROVIDER, {
      operation: "inspect",
      parameters: {},
      result: {},
    });

    const rebound = withEvidenceCallerInputPath(
      evidence,
      "/work/app/bin",
      { aux: "/work/app/aux" },
      { logicalRoot: "/work/app", logicalPrefix: "$WORKSPACE" },
    );

    expect(rebound.caller_input_path).toBe("$WORKSPACE/bin");
    expect(rebound.caller_input_paths?.aux).toBe("$WORKSPACE/aux");
    expect(() => parseEvidence(rebound)).not.toThrow();
  });
});
