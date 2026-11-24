import { createAnalysisExecutionEvidence } from "../analysisObservation.js";
import type { Evidence } from "../evidence.js";
import type { JsonValue } from "../jsonValue.js";
import type { UefiOperation, UefiRequest } from "./uefiFirmwareAnalysis.js";

export const UEFI_PROVIDER_IDENTITY = {
  id: "rea-uefi",
  name: "REA UEFI firmware parser",
  version: "1.0.0",
} as const;

export interface UefiObservationWrapper {
  readonly kind: "uefi";
  readonly result: JsonValue;
  readonly provenance?: {
    readonly path?: string;
    readonly sha256?: string;
    readonly format?: "file" | "directory";
  };
}

export const isUefiObservationWrapper = (
  value: unknown,
): value is UefiObservationWrapper =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as { kind?: unknown }).kind === "uefi" &&
  "result" in value;

export const createUefiEvidenceFromWrapper = (
  operation: UefiOperation,
  input: UefiRequest["input"],
  wrapper: UefiObservationWrapper,
): Evidence => {
  const result = wrapper.result;
  const provenance = wrapper.provenance;
  const path = provenance?.path ?? input.path;
  const sha256 =
    provenance?.sha256 ??
    (typeof (result as { image_sha256?: unknown })?.image_sha256 === "string"
      ? (result as { image_sha256: string }).image_sha256
      : "0".repeat(64));
  const format = provenance?.format ?? "file";
  const limitations =
    typeof result === "object" &&
    result !== null &&
    "limitations" in result &&
    Array.isArray((result as unknown as { limitations?: unknown }).limitations)
      ? (result as unknown as { limitations: readonly string[] }).limitations
      : [];
  const confidence =
    operation === "decompile_uefi_firmware" ? "derived" : "observed";
  return createAnalysisExecutionEvidence(
    operation,
    input,
    {
      result,
      rawResult: null,
      provider: UEFI_PROVIDER_IDENTITY,
      limitations,
      locations: [{ kind: "artifact-path", path }],
      subject: { path, sha256, format },
    },
    confidence,
  );
};
