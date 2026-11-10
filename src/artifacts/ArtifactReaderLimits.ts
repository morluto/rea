import type { ArtifactLimitBoundary } from "../domain/artifactOperationError.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { artifactReaderLimitMaximum } from "../domain/artifactReaderLimits.js";

/** Construct exact next-call recovery at the enforcing resource owner. */
export const artifactReaderLimitFailure = (
  parameter: string,
  effectiveValue: number,
  unit: "bytes" | "count",
  requiredValue?: number | bigint,
  boundary: ArtifactLimitBoundary = "capacity",
): ArtifactReaderFailure => {
  const required =
    typeof requiredValue === "bigint"
      ? requiredValue <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(requiredValue)
        : requiredValue.toString()
      : requiredValue;
  const maximum = artifactReaderLimitMaximum(parameter, unit);
  const canIncrease =
    effectiveValue < maximum &&
    (requiredValue === undefined ||
      (typeof requiredValue === "bigint"
        ? requiredValue <= BigInt(maximum)
        : requiredValue <= maximum));
  const recovery = canIncrease
    ? `Select a larger ${parameter} (1..${String(maximum)} ${unit}) and retry the same complete artifact. Changes apply on the next call without restarting REA.`
    : `No supported increase to ${parameter} can admit this observation; the maximum is ${String(maximum)} ${unit}. Keep the complete input and inspect its declared dimensions and validity. If those declarations are valid, use an explicitly selected format-specific reader that supports the required representation.`;
  const detail = `Artifact admission reached ${parameter} (${String(effectiveValue)} ${unit})${required === undefined ? "." : `; requires ${String(required)} ${unit}.`} ${recovery} Delivery paging does not raise this producer admission.`;
  return new ArtifactReaderFailure("limit", detail, {
    boundary,
    userMessage: detail,
    readerLimit: {
      parameter,
      effective_value: effectiveValue,
      unit,
      minimum: 1,
      maximum,
      ...(required === undefined ? {} : { required_value: required }),
      applies_at: "next_operation",
      agent_editable: true,
      can_increase: canIncrease,
      rea_restart_required: false,
    },
  });
};
