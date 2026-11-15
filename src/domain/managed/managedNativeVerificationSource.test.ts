import { describe, expect, it } from "vitest";

import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../../contracts/managed/managedWorkflowExamples.js";
import { createEvidence } from "../evidence.js";
import { inspectMachoSchema } from "../native/nativeInspection.js";
import { readManagedNativeVerificationSource } from "./managedNativeVerificationSource.js";

describe("managed/native verification source", () => {
  it("refuses inspect_macho Evidence without encryption reporting", () => {
    const original = MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations[0];
    if (original === undefined)
      throw new Error(
        "Managed verification example is missing native Evidence",
      );
    const { encryption: _omitted, ...withoutEncryption } =
      inspectMachoSchema.parse(original.normalized_result);
    const evidence = createEvidence(undefined, original.provider, {
      operation: "inspect_macho",
      parameters: original.parameters,
      result: withoutEncryption,
      rawResult: null,
      limitations: [],
    });
    const source = readManagedNativeVerificationSource({
      managed_boundaries:
        MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
      native_observations: [evidence],
    });
    expect(source).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
  });
});
