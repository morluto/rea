import { jsonStringCodeUnits } from "../domain/jsonSerialization.js";
import { getHeapStatistics } from "node:v8";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

/** Authentication clones parsed JSON and hashes its canonical commitment. */
const AUTHENTICATION_COPIES = 2;

/** Incremental storage of a string or null appended to an already measured array. */
export const estimateJsonArrayScalarEntry = (
  value: string | null,
  hasPrevious: boolean,
): { valueBytes: number; serializedUtf16Bytes: number } => ({
  valueBytes: 16 + (value === null ? 16 : 64 + value.length * 2),
  serializedUtf16Bytes:
    ((value === null ? 4 : jsonStringCodeUnits(value)) +
      (hasPrevious ? 1 : 0)) *
    2,
});

type StorageFrame =
  | {
      readonly kind: "array";
      readonly value: readonly unknown[];
      index: number;
    }
  | {
      readonly kind: "object";
      readonly value: Record<string, unknown>;
      readonly keys: readonly string[];
      index: number;
    };

/**
 * Parsed storage and optional UTF-16 serialization work. A bounded value scan
 * returns only a lower bound after exceeding maximumValueBytes.
 */
export const estimateJsonStorage = (
  value: unknown,
  options: {
    readonly maximumValueBytes?: number;
    readonly includeSerialized?: boolean;
  } = {},
): { valueBytes: number; serializedUtf16Bytes: number } => {
  const maximum = options.maximumValueBytes ?? Number.POSITIVE_INFINITY;
  const serialized = options.includeSerialized !== false;
  let valueBytes = 0;
  let serializedCharacters = 0;
  const stack: StorageFrame[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      valueBytes += 64 + item.length * 2;
      if (serialized && valueBytes <= maximum)
        serializedCharacters += jsonStringCodeUnits(item);
    } else if (Array.isArray(item)) {
      valueBytes += 128 + item.length * 16;
      serializedCharacters += 2 + Math.max(0, item.length - 1);
      if (item.length > 0) stack.push({ kind: "array", value: item, index: 0 });
    } else if (typeof item === "object" && item !== null) {
      valueBytes += 128;
      serializedCharacters += 2;
      const keys = Object.keys(item);
      if (keys.length > 0)
        stack.push({
          kind: "object",
          value: item as Record<string, unknown>,
          keys,
          index: 0,
        });
    } else {
      valueBytes += 16;
      serializedCharacters +=
        typeof item === "number"
          ? String(item).length
          : item === true
            ? 4
            : item === false
              ? 5
              : 4;
    }
  };
  visit(value);
  while (stack.length > 0 && valueBytes <= maximum) {
    const frame = stack[stack.length - 1]!;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        stack.pop();
        continue;
      }
      const item = frame.value[frame.index];
      frame.index += 1;
      visit(item);
    } else {
      if (frame.index >= frame.keys.length) {
        stack.pop();
        continue;
      }
      const key = frame.keys[frame.index]!;
      const isFirst = frame.index === 0;
      frame.index += 1;
      valueBytes += 64 + key.length * 2;
      if (serialized && valueBytes <= maximum)
        serializedCharacters +=
          jsonStringCodeUnits(key) + 1 + (isFirst ? 0 : 1);
      visit(frame.value[key]);
    }
  }
  return { valueBytes, serializedUtf16Bytes: serializedCharacters * 2 };
};

/** Refuse before authentication when live heap headroom cannot hold its validation and commitment working copies. */
export const requireAuthenticationHeadroom = (
  value: unknown,
  options: {
    readonly operation: string;
    readonly path: string;
    readonly description: string;
    readonly availableBytes?: number;
    /** A caller's real serialization ceiling, checked before allocating JSON text. */
    readonly serializedCodeUnitLimit?: number;
    readonly additional?: {
      readonly valueBytes: number;
      readonly serializedUtf16Bytes: number;
    };
  },
): Result<void, AnalysisResourceConstraintError> => {
  const availableBytes =
    options.availableBytes ?? getHeapStatistics().total_available_size;
  const estimate = estimateJsonStorage(value);
  const valueBytes =
    estimate.valueBytes + (options.additional?.valueBytes ?? 0);
  const serializedUtf16Bytes =
    estimate.serializedUtf16Bytes +
    (options.additional?.serializedUtf16Bytes ?? 0);
  const serializedCodeUnits = serializedUtf16Bytes / 2;
  if (
    options.serializedCodeUnitLimit !== undefined &&
    serializedCodeUnits > options.serializedCodeUnitLimit
  )
    return err(
      new AnalysisResourceConstraintError(
        options.operation,
        "memory",
        `${options.description}: expanded JSON exceeds the single-string serialization limit.`,
        {
          input_path: options.path,
          serialized_json_code_units: serializedCodeUnits,
          maximum_serialized_json_code_units: options.serializedCodeUnitLimit,
        },
        {
          retryable: false,
          remediationAction:
            "Reduce the selected facts before serialization. If the question requires the complete representation above this ceiling, report this unsupported size instead of repeating the unchanged request. Increasing heap or command-output admission does not raise the serialization ceiling. A delivery summary cannot repair an Evidence record that could not be assembled.",
        },
      ),
    );
  // Canonical hashing and manifest normalization can still encode scalars or
  // metadata; account for their escaped representations before allocating them.
  const requiredBytes =
    (valueBytes + serializedUtf16Bytes) * AUTHENTICATION_COPIES;
  if (requiredBytes <= availableBytes) return ok(undefined);
  return err(
    new AnalysisResourceConstraintError(
      options.operation,
      "memory",
      options.description,
      {
        input_path: options.path,
        projected_value_bytes: valueBytes,
        serialized_json_utf16_bytes: serializedUtf16Bytes,
        authentication_bytes: requiredBytes,
        available_heap_bytes: availableBytes,
      },
      { measuredExhaustion: true },
    ),
  );
};
