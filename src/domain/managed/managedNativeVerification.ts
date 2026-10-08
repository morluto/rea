import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type { Evidence } from "../evidence.js";
import {
  managedNativeBoundaryInspectionSchema,
  type ManagedNativeBoundaryInspection,
} from "./managedArtifact.js";
import { parseManagedInspectionEvidence } from "./managedInspectionEvidence.js";
import type { JsonValue } from "../jsonValue.js";
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

const parseManagedBoundary = (
  input: ManagedNativeVerificationInput,
): {
  readonly evidence: Evidence;
  readonly result: ManagedNativeBoundaryInspection;
} =>
  parseManagedInspectionEvidence(
    input.managed_boundaries,
    "inspect_managed_native_boundaries",
    managedNativeBoundaryInspectionSchema,
  );

/** Verify managed P/Invoke declarations against authenticated native Evidence. */
export const verifyManagedNativeBoundaries = (
  input: ManagedNativeVerificationInput,
): ManagedNativeVerificationResult => {
  const { evidence: managedEvidence, result: managed } =
    parseManagedBoundary(input);
  const native = collectNativeSymbols(input.native_observations);
  const verifiedPinvokes = managed.pinvoke_imports.map((item) =>
    verifyPinvoke({
      item,
      managedEvidenceId: managedEvidence.evidence_id,
      native,
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
    input,
  });
  return managedNativeVerificationResultSchema.parse({
    ...withoutId,
    verification_id: `mnv_${sha256(withoutId)}`,
  });
};
