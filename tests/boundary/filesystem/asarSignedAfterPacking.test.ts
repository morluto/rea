import { expect, it } from "vitest";

import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createSignedAfterPackingAsarAddon } from "../../fixtures/signedAfterPackingAsarAddon.js";
import { createStrippedAsarAddon } from "../../fixtures/strippedAsarAddon.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";

it("classifies an unpacked PE signed after packing without trusting the bytes", async () => {
  const { archive, addon, declaredSha256, observedSha256 } =
    await createSignedAfterPackingAsarAddon();

  const rejected = await analyzeJavaScriptApplication({ input_path: archive });
  if (rejected.ok) throw new Error("Expected strict integrity failure");
  expect(projectAnalysisError(rejected.error)).toMatchObject({
    code: "artifact_integrity_mismatch",
    details: {
      logical_path: addon,
      declared_sha256: declaredSha256,
      calculated_sha256: observedSha256,
      unpacked: true,
      signing_explanation: {
        kind: "signed-after-packing",
        platform: "pe-authenticode",
        unsigned_sha256: declaredSha256,
        signer_subjects: [expect.stringContaining("commonName=REA Fixture")],
      },
    },
  });

  const continued = await analyzeJavaScriptApplication({
    input_path: archive,
    integrity_policy: "record-and-continue",
  });
  if (!continued.ok) throw new Error("Expected explicit continuation");
  const result = javascriptApplicationAnalysisResultSchema.parse(
    continued.value.normalized_result,
  );
  const contradiction = result.integrity_contradictions.find(
    ({ logical_path }) => logical_path === addon,
  );
  expect(contradiction).toMatchObject({
    logical_path: addon,
    declared_sha256: declaredSha256,
    observed_sha256: observedSha256,
    trust: "observed-untrusted",
    signing_explanation: {
      kind: "signed-after-packing",
      platform: "pe-authenticode",
      unsigned_sha256: declaredSha256,
    },
  });
  expect(contradiction?.limitations[0]).toContain("signed-after-packing");
  expect(result.limitations).toContain(
    `Artifact integrity metadata contradicts observed bytes at ${addon}; removing the Authenticode certificate table restores the declared SHA-256 (signed after packing), but the observed bytes remain untrusted.`,
  );
});

it("keeps an ordinary unpacked mismatch unexplained", async () => {
  const { archive, addon } = await createStrippedAsarAddon();
  const continued = await analyzeJavaScriptApplication({
    input_path: archive,
    integrity_policy: "record-and-continue",
  });
  if (!continued.ok) throw new Error("Expected explicit continuation");
  const result = javascriptApplicationAnalysisResultSchema.parse(
    continued.value.normalized_result,
  );
  const contradiction = result.integrity_contradictions.find(
    ({ logical_path }) => logical_path === addon,
  );
  expect(contradiction).toMatchObject({
    logical_path: addon,
    trust: "observed-untrusted",
  });
  expect(contradiction).not.toHaveProperty("signing_explanation");
});
