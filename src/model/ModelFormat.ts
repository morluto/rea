import {
  malformedInput,
  ParseFailureError,
  unsupportedInput,
} from "../domain/parseFailure.js";

/** Producing constraint for a model capacity refusal. Recovery uses this, not message text. */
export const MODEL_CAPACITY_LIMITS = [
  "header-bytes",
  "report-bytes",
  "representation-bytes",
  "exact-offset",
  "metadata-nesting",
  "json-nesting",
] as const;

/** Which fixed model allowance refused the request. */
export type ModelCapacityLimit = (typeof MODEL_CAPACITY_LIMITS)[number];

/** The ParseFailure format of GGUF and Safetensors model headers. */
export const MODEL_FORMAT = "model";

/** A fixed model allowance refused the input; the limit name is its {@link ModelCapacityLimit}. */
export const modelCapacityFailure = (
  limit: ModelCapacityLimit,
  detail: string,
): ParseFailureError<"limit"> =>
  new ParseFailureError({
    kind: "limit",
    format: MODEL_FORMAT,
    detail,
    limit: {
      name: limit,
      maximum: Object.values(modelCapacityReportedLimits(limit))[0] ?? 0,
    },
  });

/** The model allowance a failure names, or undefined for any other failure. */
export const modelCapacityLimitOf = (
  cause: ParseFailureError,
): ModelCapacityLimit | undefined => {
  const { failure } = cause;
  if (failure.kind !== "limit") return undefined;
  return MODEL_CAPACITY_LIMITS.find((limit) => limit === failure.limit.name);
};

export function rejectModel(message: string): never {
  throw malformedInput(MODEL_FORMAT, message);
}

export function rejectPickle(): never {
  throw unsupportedInput(
    MODEL_FORMAT,
    "PyTorch pickle/ZIP model deserialization is unsupported; supply GGUF or safetensors instead",
  );
}

// Shared header ceiling for GGUF and Safetensors. Safetensors counts declared
// JSON bytes after the eight-byte length prefix; GGUF counts the complete
// header. Retained rows and the serialized report have separate allowances.
export const MODEL_HEADER_BYTES = 100_000_000;
export const MODEL_REPORT_BYTES = 32 * 1024 * 1024;
export const MODEL_ARRAY_PREVIEW = 8;
export const MODEL_METADATA_NESTING = 32;
export const MODEL_JSON_NESTING = 32;

const fixedModelLimit = (allowance: string): string =>
  `${allowance}. This release has no runtime override. Additional host memory does not raise it. Repeating the unchanged request fails the same way.`;

/** Recovery for the allowance that actually refused the model. Host memory does not raise it. */
export const modelCapacityRemediation = (limit: ModelCapacityLimit): string => {
  switch (limit) {
    case "header-bytes":
      return fixedModelLimit("The model header allowance is 100,000,000 bytes");
    case "report-bytes":
      return fixedModelLimit(
        `The retained model report allowance is ${String(MODEL_REPORT_BYTES)} bytes`,
      );
    case "representation-bytes":
      return fixedModelLimit(
        `The retained model representation allowance is ${String(MODEL_REPORT_BYTES)} bytes`,
      );
    case "exact-offset":
      return fixedModelLimit(
        `Exact host offset precision stops at ${String(Number.MAX_SAFE_INTEGER)}`,
      );
    case "metadata-nesting":
      return fixedModelLimit(
        `GGUF metadata nesting is limited to ${String(MODEL_METADATA_NESTING)} array frames`,
      );
    case "json-nesting":
      return fixedModelLimit(
        `Safetensors JSON nesting is limited to ${String(MODEL_JSON_NESTING)} levels`,
      );
  }
};

/** Limits that belong to the producing constraint, without unrelated ceilings. */
export const modelCapacityReportedLimits = (
  limit: ModelCapacityLimit,
): Readonly<Record<string, number>> => {
  switch (limit) {
    case "header-bytes":
      return { maximum_header_bytes: MODEL_HEADER_BYTES };
    case "report-bytes":
      return { maximum_report_bytes: MODEL_REPORT_BYTES };
    case "representation-bytes":
      return { maximum_representation_bytes: MODEL_REPORT_BYTES };
    case "exact-offset":
      return { maximum_exact_offset: Number.MAX_SAFE_INTEGER };
    case "metadata-nesting":
      return { maximum_array_frames: MODEL_METADATA_NESTING };
    case "json-nesting":
      return { maximum_json_depth: MODEL_JSON_NESTING };
  }
};

/** Charge representation growth before retaining rows or decoding long strings. */
export class ModelReportBudget {
  #remaining = MODEL_REPORT_BYTES;
  charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#remaining)
      throw modelCapacityFailure(
        "representation-bytes",
        "Model facts exceed the 32 MiB retained representation budget. This release has no runtime override.",
      );
    this.#remaining -= bytes;
  }
}
