import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { parseEvidence } from "./evidence.js";
import {
  managedNativeBoundaryInspectionSchema,
  type ManagedNativeBoundaryInspection,
} from "./managedArtifact.js";
import type { JsonValue } from "./jsonValue.js";
import {
  managedNativeVerificationResultSchema,
  type ManagedNativeVerificationInput,
  type ManagedNativeVerificationResult,
} from "./managedNativeVerificationSchemas.js";
import {
  buildVerificationResult,
  collectNativeSymbols,
  verifyPinvoke,
} from "./managedNativeVerificationMatch.js";

export {
  managedNativeVerificationInputSchema,
  type ManagedNativeVerificationInput,
  type ManagedNativeVerificationResult,
} from "./managedNativeVerificationSchemas.js";
export { managedNativeVerificationResultSchema };

const sha256 = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed/native verification canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

const managedBoundaryFromInput = (
  input: ManagedNativeVerificationInput,
): ManagedNativeBoundaryInspection => {
  const managedEvidence = parseEvidence(input.managed_boundaries);
  if (managedEvidence.operation !== "inspect_managed_native_boundaries")
    throw new TypeError(
      "Evidence operation is not inspect_managed_native_boundaries",
    );
  return managedNativeBoundaryInspectionSchema.parse(
    managedEvidence.normalized_result,
  );
};

/** Verify managed P/Invoke declarations against authenticated native Evidence. */
export const verifyManagedNativeBoundaries = (
  input: ManagedNativeVerificationInput,
): ManagedNativeVerificationResult => {
  const managed = managedBoundaryFromInput(input);
  const managedEvidence = parseEvidence(input.managed_boundaries);
  const native = collectNativeSymbols(
    input.native_observations.slice(0, input.limits.max_native_observations),
  );
  const verifiedPinvokes = managed.pinvoke_imports.items.map((item) =>
    verifyPinvoke({
      item,
      managedEvidenceId: managedEvidence.evidence_id,
      symbols: native.symbols,
      hasSupportedNativeEvidence: native.accepted > 0,
      input,
    }),
  );
  const pinvokeImports = verifiedPinvokes.map(
    ({ verification }) => verification,
  );
  const withoutId = buildVerificationResult({
    managedEvidence,
    managed,
    native,
    pinvokeImports,
    verifiedPinvokes,
    input,
  });
  return managedNativeVerificationResultSchema.parse({
    ...withoutId,
    verification_id: `mnv_${sha256(withoutId)}`,
  });
};
