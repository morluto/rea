import { constants as bufferConstants } from "node:buffer";
import { jsonStringCodeUnits } from "../../domain/jsonSerialization.js";
import { isImmutableEvidence } from "../../domain/evidence.js";
import { readImmutableEvidence } from "../../domain/evidenceValidation.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { jsonValueValidationIssue } from "../../domain/jsonValue.js";
import { err } from "../../domain/result.js";
import type { EvidenceInputPath } from "../../domain/evidenceInputContract.js";
import {
  androidDeclarationOccurrence,
  ANDROID_DECLARATION_COMPARISON_REASONS,
  type AndroidPackageDeclarations,
} from "../../domain/android/androidDeclarationComparison.js";
import {
  estimateJsonStorage,
  requireAuthenticationHeadroom,
} from "../JsonAuthenticationHeadroom.js";

/** Admit complete mutable source representations before authentication copies or hashes them. */
export const readAndroidDeclarationSource = (
  input: unknown,
  path: EvidenceInputPath,
) => {
  const side = path[0] === "left" || path[0] === "right" ? path[0] : undefined;
  const location = side === undefined ? undefined : { side };
  // Only the Evidence owner's authenticated snapshot proof permits borrowing.
  // A retained selector or an independently frozen JSON object is insufficient.
  if (isImmutableEvidence(input)) return readImmutableEvidence(input, location);
  const issue = jsonValueValidationIssue(input);
  if (issue !== undefined)
    return err(
      new EvidenceIntegrityError("Android source is not ordinary JSON", {
        userMessage: issue,
        ...location,
      }),
    );
  const admission = requireAuthenticationHeadroom(input, {
    operation: "compare_android_declarations",
    path: path.join("."),
    description: "Complete Android source Evidence cannot be authenticated",
  });
  return admission.ok ? readImmutableEvidence(input, location) : admission;
};

/**
 * Admit an upper bound before retaining groups, copied occurrences or sets.
 * Each source occurrence may require its own delta group; pairing and omitted
 * unchanged groups only reduce that bound. Unrelated manifest text is excluded.
 */
export const requireAndroidDeclarationComparisonHeadroom = (
  envelope: unknown,
  left: AndroidPackageDeclarations,
  right: AndroidPackageDeclarations,
  availableBytes?: number,
) => {
  let valueBytes = 0;
  let serializedUtf16Bytes = 0;
  const reason = Object.values(ANDROID_DECLARATION_COMPARISON_REASONS).reduce(
    (longest, value) => (value.length > longest.length ? value : longest),
    "",
  );
  for (const report of [left, right]) {
    for (const [index, item] of report.components.items.entries()) {
      const row = {
        kind: item.kind,
        name: item.name,
        state: "unknown",
        left: [androidDeclarationOccurrence(item, index)],
        right: [],
        fields: {
          exported: "unchanged",
          permission: "unchanged",
          authorities: "unchanged",
        },
        reason,
      };
      const estimate = estimateJsonStorage(row);
      // Include the JSON [kind,name] Map key and sorted-array references.
      const keyCodeUnits =
        3 + jsonStringCodeUnits(item.kind) + jsonStringCodeUnits(item.name);
      valueBytes += estimate.valueBytes + 64 + keyCodeUnits * 2 + 3 * 16;
      serializedUtf16Bytes += estimate.serializedUtf16Bytes + 2;
    }
    // Each observed permission can appear in one distinct-name output array.
    // Include source strings plus working Sets and sorted-array slots. Counting
    // repeated names deliberately overestimates the distinct output.
    const permissions = estimateJsonStorage(report.permissions);
    valueBytes += permissions.valueBytes + report.permissions.length * 3 * 16;
    serializedUtf16Bytes += permissions.serializedUtf16Bytes;
  }
  return requireAuthenticationHeadroom(envelope, {
    operation: "compare_android_declarations",
    path: "selected Android package declarations",
    description:
      "Android declaration comparison working representation cannot be assembled",
    serializedCodeUnitLimit: bufferConstants.MAX_STRING_LENGTH,
    ...(availableBytes === undefined ? {} : { availableBytes }),
    additional: { valueBytes, serializedUtf16Bytes },
  });
};
