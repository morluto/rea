import { describe, expect, it } from "vitest";

import { verifyManagedNativeBoundariesEvidence } from "../src/application/ManagedNativeVerificationService.js";
import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../src/contracts/managedWorkflowExamples.js";
import { createEvidence } from "../src/domain/evidence.js";
import {
  managedNativeVerificationInputSchema,
  verifyManagedNativeBoundaries,
} from "../src/domain/managedNativeVerification.js";
import { inspectMachoSchema } from "../src/domain/nativeInspection.js";

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

describe("managed/native boundary verification", () => {
  it("verifies a P/Invoke declaration against native export Evidence", () => {
    const result = verifyManagedNativeBoundaries(exampleInput());

    expect(result).toMatchObject({
      schema_version: 1,
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

  it("reports omitted native candidates when candidate limits truncate matches", () => {
    const result = verifyManagedNativeBoundaries({
      ...exampleInput(),
      native_observations: [
        nativeEvidenceWithExports(["open_native", "_open_native"]),
      ],
      limits: { max_native_observations: 20, max_candidates_per_import: 1 },
    });

    expect(result.coverage).toMatchObject({
      status: "truncated",
      omitted_candidates: 1,
    });
    expect(result.pinvoke_imports[0]?.candidates).toHaveLength(1);
  });

  it("wraps verification in derived workflow Evidence", () => {
    const evidence = verifyManagedNativeBoundariesEvidence(exampleInput());

    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
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
