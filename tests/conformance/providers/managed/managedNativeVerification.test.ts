import { describe, expect, it } from "vitest";

import { verifyManagedNativeBoundariesEvidence } from "../../../../src/application/managed/ManagedNativeVerificationService.js";
import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../../../../src/contracts/managed/managedWorkflowExamples.js";
import { createEvidence } from "../../../../src/domain/evidence.js";
import {
  managedNativeVerificationInputSchema,
  managedNativeVerificationResultSchema,
  verifyManagedNativeBoundaries,
} from "../../../../src/domain/managed/managedNativeVerification.js";
import { managedNativeBoundaryInspectionSchema } from "../../../../src/domain/managed/managedArtifact.js";
import { inspectMachoSchema } from "../../../../src/domain/native/nativeInspection.js";

const exampleInput = () =>
  managedNativeVerificationInputSchema.parse(
    MANAGED_NATIVE_VERIFICATION_EXAMPLE,
  );

const nativeEvidenceWithExports = (names: readonly string[]) => {
  const input = exampleInput();
  const native = input.native_observations[0];
  if (native === undefined || native.subject === null)
    throw new Error("missing native example");
  const macho = inspectMachoSchema.parse(native.normalized_result);
  return createEvidence(
    {
      path: native.subject.local_path,
      sha256: native.subject.digest.sha256,
      format: native.subject.format,
      ...(native.subject.architecture === null
        ? {}
        : { architecture: native.subject.architecture }),
    },
    native.provider,
    {
      operation: native.operation,
      parameters: native.parameters,
      result: {
        ...macho,
        exports: {
          ...macho.exports,
          items: names.map((name, index) => ({
            name,
            address: `0x${(0x1000 + index).toString(16)}`,
            weak: false,
            reexport: false,
            source: "nm",
          })),
          total: names.length,
        },
      },
      rawResult: native.raw_result,
      confidence: native.confidence,
      authority: native.authority,
      environment: native.environment,
      limitations: native.limitations,
      locations: native.locations,
      evidenceLinks: native.evidence_links,
    },
  );
};

describe("managed/native boundary Evidence identity", () => {
  it("rejects managed boundary Evidence whose subject digest differs from its artifact", () => {
    const input = exampleInput();
    const managed = input.managed_boundaries;
    const result = managedNativeBoundaryInspectionSchema.parse(
      managed.normalized_result,
    );
    const otherDigest = "b".repeat(64);
    const mismatched = createEvidence(
      {
        path: result.artifact.path,
        sha256: result.artifact.sha256,
        format: "pe",
      },
      managed.provider,
      {
        operation: managed.operation,
        parameters: managed.parameters,
        result: {
          ...result,
          artifact: { ...result.artifact, sha256: otherDigest },
          identity_scope: {
            ...result.identity_scope,
            requires_artifact_sha256: otherDigest,
          },
        },
        rawResult: managed.raw_result,
        confidence: managed.confidence,
        authority: managed.authority,
        environment: managed.environment,
        limitations: managed.limitations,
        locations: managed.locations,
        evidenceLinks: managed.evidence_links,
      },
    );

    expect(() =>
      verifyManagedNativeBoundaries({
        ...input,
        managed_boundaries: mismatched,
      }),
    ).toThrow(
      `Managed Evidence inspect_managed_native_boundaries (${mismatched.evidence_id}) subject SHA-256 ${result.artifact.sha256} does not match normalized artifact SHA-256 ${otherDigest}`,
    );
    expect(verifyManagedNativeBoundaries(input).summary.verified).toBe(1);
  });
});

describe("managed/native boundary verification", () => {
  it("verifies a P/Invoke declaration against native export Evidence", () => {
    const result = verifyManagedNativeBoundaries(exampleInput());

    expect(result).toMatchObject({
      algorithm: {
        name: "rea-managed-native-verification",
        token_to_address_mapping: "not-inferred",
      },
      managed_boundary: {
        artifact_sha256: "6".repeat(64),
        mvid: "00112233-4455-4677-8899-aabbccddeeff",
        pinvoke_imports_total: 1,
      },
      native_observations: {
        total: 1,
        accepted: 1,
        unsupported: 0,
        symbols: 1,
      },
      summary: {
        verified: 1,
        inferred: 0,
        unresolved: 0,
        contradicted: 0,
      },
      pinvoke_imports: [
        {
          managed: {
            import_name: "open_native",
            import_scope_name: "nativehelper.dll",
            declaration_verification: "managed-declaration-only",
          },
          status: "verified",
          basis: "exact-export-name",
          confidence: "observed",
          matched_native: {
            name: "open_native",
            source: "macho-export",
          },
        },
      ],
    });
    expect(result.verification_id).toMatch(/^mnv_[a-f0-9]{64}$/u);
    expect(result.limitations.join(" ")).toContain(
      "does not prove CLR binding",
    );
  });

  it("reports module mismatch as a contradiction within supplied Evidence", () => {
    const input = exampleInput();
    const native = input.native_observations[0];
    if (native === undefined || native.subject === null)
      throw new Error("missing native example");
    const mismatched = createEvidence(
      {
        path: "/examples/other.dll",
        sha256: native.subject.digest.sha256,
        format: "pe",
        ...(native.subject.architecture === null
          ? {}
          : { architecture: native.subject.architecture }),
      },
      native.provider,
      {
        operation: native.operation,
        parameters: native.parameters,
        result: native.normalized_result,
        rawResult: native.raw_result,
        confidence: native.confidence,
        authority: native.authority,
        environment: native.environment,
        limitations: native.limitations,
        locations: native.locations,
        evidenceLinks: native.evidence_links,
      },
    );

    const result = verifyManagedNativeBoundaries({
      ...input,
      native_observations: [mismatched],
    });

    expect(result.summary).toMatchObject({
      verified: 0,
      contradicted: 1,
    });
    expect(result.pinvoke_imports[0]).toMatchObject({
      status: "contradicted",
      basis: "module-mismatch",
    });
  });

  it("treats supported native Evidence with no symbols as unresolved", () => {
    const result = verifyManagedNativeBoundaries({
      ...exampleInput(),
      native_observations: [nativeEvidenceWithExports([])],
    });

    expect(result.native_observations).toMatchObject({
      accepted: 1,
      unsupported: 0,
      symbols: 0,
    });
    expect(result.summary).toMatchObject({
      verified: 0,
      unresolved: 1,
    });
    expect(result.pinvoke_imports[0]).toMatchObject({
      status: "unresolved",
      basis: "no-native-candidate",
    });
  });

  it("does not verify a symbol whose spelling differs only by case", () => {
    const result = verifyManagedNativeBoundaries({
      ...exampleInput(),
      native_observations: [nativeEvidenceWithExports(["OPEN_NATIVE"])],
    });

    expect(result.summary).toMatchObject({ verified: 0, unresolved: 1 });
    expect(result.pinvoke_imports[0]).toMatchObject({
      status: "unresolved",
      matched_native: null,
      candidates: [],
    });
  });

  it("retains every observed native candidate", () => {
    const result = verifyManagedNativeBoundaries({
      ...exampleInput(),
      native_observations: [
        nativeEvidenceWithExports(["open_native", "_open_native"]),
      ],
    });

    expect(result.coverage).toMatchObject({
      status: "complete-within-inputs",
    });
    expect(result.pinvoke_imports[0]?.candidates).toHaveLength(2);
  });

  it("wraps verification in derived workflow Evidence", () => {
    const evidence = verifyManagedNativeBoundariesEvidence(exampleInput());

    if (!evidence.ok) throw evidence.error;
    expect(evidence.value).toMatchObject({
      operation: "verify_managed_native_boundaries",
      provider: { id: "rea-dotnet-workflows" },
      confidence: "inferred",
      authority: "analyst-inference",
      normalized_result: {
        summary: { verified: 1 },
      },
    });
    expect(evidence.value.evidence_links).toHaveLength(2);
  });
});

describe("managed/native verification result algebra", () => {
  it("rejects states without their required native match", () => {
    const result = verifyManagedNativeBoundaries(exampleInput());
    const verification = result.pinvoke_imports[0];
    expect(verification).toBeDefined();
    if (verification === undefined) return;

    expect(
      managedNativeVerificationResultSchema.safeParse({
        ...result,
        pinvoke_imports: [
          {
            ...verification,
            matched_native: null,
            candidates: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      managedNativeVerificationResultSchema.safeParse({
        ...result,
        pinvoke_imports: [
          {
            ...verification,
            status: "unresolved",
            basis: "no-native-candidate",
            confidence: "unknown",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      managedNativeVerificationResultSchema.safeParse({
        ...result,
        coverage: {
          status: "complete-within-inputs",
          omitted_native_observations: 0,
          omitted_candidates: 1,
        },
      }).success,
    ).toBe(false);
  });
});

it("does not erase a C identifier underscore beyond the Mach-O ABI prefix", () => {
  const result = verifyManagedNativeBoundaries({
    ...exampleInput(),
    native_observations: [nativeEvidenceWithExports(["__open_native"])],
  });
  expect(result.summary).toMatchObject({ inferred: 0, unresolved: 1 });
  expect(result.pinvoke_imports[0]).toMatchObject({
    status: "unresolved",
    candidates: [],
    matched_native: null,
  });
});

it("does not treat a raw Mach-O ABI name as an exact underscored C identifier", () => {
  const input = exampleInput();
  const managed = input.managed_boundaries;
  const normalized = managedNativeBoundaryInspectionSchema.parse(
    managed.normalized_result,
  );
  const imports = normalized.pinvoke_imports;
  const result = verifyManagedNativeBoundaries({
    ...input,
    managed_boundaries: createEvidence(undefined, managed.provider, {
      operation: managed.operation,
      parameters: managed.parameters,
      result: {
        ...normalized,
        pinvoke_imports: imports.map((item) => ({
          ...item,
          import_name: "_open_native",
          no_mangle: true,
        })),
      },
      rawResult: null,
    }),
    native_observations: [nativeEvidenceWithExports(["_open_native"])],
  });
  expect(result.summary).toMatchObject({
    verified: 0,
    inferred: 0,
    unresolved: 1,
  });
  expect(result.pinvoke_imports[0]?.candidates).toEqual([]);
});
