import { z } from "zod";
import { AnalysisInputError } from "../analysisErrorCore.js";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import type { JsonValue } from "../jsonValue.js";
import {
  parameterBudgetLimit,
  type ParameterBudget,
} from "../parameterBudget.js";
import { err, ok, type Result } from "../result.js";

/** Default and maximum source plist file byte budget (64 MiB; whole file read into heap). */
export const DEFAULT_NATIVE_PLIST_FILE_BYTES = 64 * 1024 * 1024;
/** Default and maximum estimated decoded XML/binary plist byte budget (64 MiB; whole DOM/object tree on heap). */
export const DEFAULT_NATIVE_PLIST_DECODE_BYTES = 64 * 1024 * 1024;

/** Per-call budgets for `inspect_plist`, shared by its schema and refusals. */
const NATIVE_PLIST_BUDGETS = {
  max_file_bytes: {
    minimum: 1,
    maximum: DEFAULT_NATIVE_PLIST_FILE_BYTES,
    default_value: DEFAULT_NATIVE_PLIST_FILE_BYTES,
    unit: "bytes",
  },
  max_decoded_bytes: {
    minimum: 1,
    maximum: DEFAULT_NATIVE_PLIST_DECODE_BYTES,
    default_value: DEFAULT_NATIVE_PLIST_DECODE_BYTES,
    unit: "bytes",
  },
} as const satisfies Record<string, ParameterBudget>;

type NativePlistBudgetField = keyof typeof NATIVE_PLIST_BUDGETS;

/** Build a structured per-call refusal limit using the contract's own bounds. */
export const nativePlistBudgetLimit = (
  parameter: NativePlistBudgetField,
  effectiveValue: number,
  requiredValue?: number,
): AnalysisParameterLimit => ({
  ...parameterBudgetLimit(
    parameter,
    NATIVE_PLIST_BUDGETS[parameter],
    effectiveValue,
  ),
  ...(requiredValue === undefined ? {} : { required_value: requiredValue }),
});

/** Optional per-call budget fields for `inspect_plist` (omitted stays omitted in Evidence). */
export const nativePlistBudgetFields = {
  max_file_bytes: z
    .int()
    .min(NATIVE_PLIST_BUDGETS.max_file_bytes.minimum)
    .max(NATIVE_PLIST_BUDGETS.max_file_bytes.maximum)
    .optional()
    .describe(
      "Maximum source plist file bytes to read (default and maximum 64 MiB)",
    ),
  max_decoded_bytes: z
    .int()
    .min(NATIVE_PLIST_BUDGETS.max_decoded_bytes.minimum)
    .max(NATIVE_PLIST_BUDGETS.max_decoded_bytes.maximum)
    .optional()
    .describe(
      "Maximum estimated decoded XML or binary plist representation bytes (default and maximum 64 MiB)",
    ),
};

export interface NativePlistBudgetSelection {
  readonly maxFileBytes: number;
  readonly maxDecodedBytes: number;
}

const parseBudgetParameter = (
  parameters: Readonly<Record<string, JsonValue>>,
  field: NativePlistBudgetField,
): Result<number, AnalysisInputError> => {
  const raw = parameters[field];
  const budget = NATIVE_PLIST_BUDGETS[field];
  if (raw === undefined) return ok(budget.default_value);
  if (typeof raw !== "number" || !Number.isInteger(raw))
    return err(
      new AnalysisInputError("inspect_plist", undefined, [
        {
          path: [field],
          reason: "invalid_type",
          message: `${field} must be an integer between ${String(budget.minimum)} and ${String(budget.maximum)}.`,
        },
      ]),
    );
  if (raw < budget.minimum || raw > budget.maximum)
    return err(
      new AnalysisInputError("inspect_plist", undefined, [
        {
          path: [field],
          reason: "out_of_range",
          minimum: budget.minimum,
          maximum: budget.maximum,
          message: `${field} must be between ${String(budget.minimum)} and ${String(budget.maximum)} bytes.`,
        },
      ]),
    );
  return ok(raw);
};

/** Resolve optional `inspect_plist` budget inputs at the provider boundary. */
export const parseNativePlistBudgetParameters = (
  parameters: Readonly<Record<string, JsonValue>>,
): Result<NativePlistBudgetSelection, AnalysisInputError> => {
  const maxFileBytes = parseBudgetParameter(parameters, "max_file_bytes");
  if (!maxFileBytes.ok) return maxFileBytes;
  const maxDecodedBytes = parseBudgetParameter(parameters, "max_decoded_bytes");
  if (!maxDecodedBytes.ok) return maxDecodedBytes;
  return ok({
    maxFileBytes: maxFileBytes.value,
    maxDecodedBytes: maxDecodedBytes.value,
  });
};
