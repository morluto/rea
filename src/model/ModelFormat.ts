import { Budget } from "../domain/budget.js";
import {
  decodeLimit,
  malformedInput,
  type ParseFailureError,
  unsupportedInput,
} from "../domain/parseFailure.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";

/** The ParseFailure format of GGUF and Safetensors model headers. */
export const MODEL_FORMAT = "model";

/** A fixed model allowance refused the input; the limit name is its {@link ModelCapacityLimit}. */
export const modelCapacityFailure = (
  limit: ModelCapacityLimit,
  detail: string,
): ParseFailureError<"limit"> =>
  decodeLimit(MODEL_FORMAT, detail, {
    name: limit,
    maximum: modelCapacityLimits[limit].maximum,
  });

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

const modelCapacityLimits = {
  "header-bytes": {
    maximum: MODEL_HEADER_BYTES,
    legacyMaximumKey: "maximum_header_bytes",
    allowance: (maximum: number) =>
      `The model header allowance is ${maximum.toLocaleString("en-US")} bytes`,
  },
  "report-bytes": {
    maximum: MODEL_REPORT_BYTES,
    legacyMaximumKey: "maximum_report_bytes",
    allowance: (maximum: number) =>
      `The retained model report allowance is ${String(maximum)} bytes`,
  },
  "representation-bytes": {
    maximum: MODEL_REPORT_BYTES,
    legacyMaximumKey: "maximum_representation_bytes",
    allowance: (maximum: number) =>
      `The retained model representation allowance is ${String(maximum)} bytes`,
  },
  "exact-offset": {
    maximum: Number.MAX_SAFE_INTEGER,
    legacyMaximumKey: "maximum_exact_offset",
    allowance: (maximum: number) =>
      `Exact host offset precision stops at ${String(maximum)}`,
  },
  "metadata-nesting": {
    maximum: MODEL_METADATA_NESTING,
    legacyMaximumKey: "maximum_array_frames",
    allowance: (maximum: number) =>
      `GGUF metadata nesting is limited to ${String(maximum)} array frames`,
  },
  "json-nesting": {
    maximum: MODEL_JSON_NESTING,
    legacyMaximumKey: "maximum_json_depth",
    allowance: (maximum: number) =>
      `Safetensors JSON nesting is limited to ${String(maximum)} levels`,
  },
} as const;

type ModelCapacityLimit = keyof typeof modelCapacityLimits;

const isModelCapacityLimit = (name: string): name is ModelCapacityLimit =>
  Object.hasOwn(modelCapacityLimits, name);

/** The model parser supplies the enforced maximum and the original cause. */
export const modelCapacityConstraint = (operation: string, cause: unknown) => {
  if (!isParseLimit(cause, MODEL_FORMAT)) return undefined;
  const { name, maximum } = cause.failure.limit;
  if (!isModelCapacityLimit(name)) return undefined;
  const { allowance, legacyMaximumKey } = modelCapacityLimits[name];
  return parseLimitConstraint(operation, "memory", cause, {
    legacyMaximumKey,
    retryable: false,
    remediationAction: fixedModelLimit(allowance(maximum)),
  });
};

/** Charge representation growth before retaining rows or decoding long strings. */
export class ModelReportBudget {
  readonly #bytes = new Budget(MODEL_REPORT_BYTES);
  charge(bytes: number): void {
    this.#bytes.charge(bytes, () =>
      modelCapacityFailure(
        "representation-bytes",
        "Model facts exceed the 32 MiB retained representation budget. This release has no runtime override.",
      ),
    );
  }
}
