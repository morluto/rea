import { createHash } from "node:crypto";

/** Hash canonicalize-compatible JSON without assembling an aggregate string. */
export const digestCanonicalValue = (
  value: unknown,
  context = "Comparison",
): string => {
  const hash = createHash("sha256");
  // Batch small emitted parts to cut hash.update crossings.
  // Flush cuts only at part boundaries, so the hashed byte stream is unchanged.
  let buffered = "";
  const emit = (part: string): void => {
    buffered += part;
    if (buffered.length >= 8192) {
      hash.update(buffered);
      buffered = "";
    }
  };
  const encoded = emitCanonical(value, emit, new Set());
  if (!encoded) throw new TypeError(`${context} could not canonicalize data`);
  if (buffered) hash.update(buffered);
  return hash.digest("hex");
};

type Emit = (part: string) => void;

const emitCanonical = (
  value: unknown,
  emit: Emit,
  ancestors: Set<object>,
): boolean => {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error(
      Number.isNaN(value) ? "NaN is not allowed" : "Infinity is not allowed",
    );
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return false;
    emit(encoded);
    return true;
  }
  if (ancestors.has(value)) throw new Error("Circular reference detected");
  ancestors.add(value);
  try {
    if ("toJSON" in value && typeof value.toJSON === "function") {
      const normalized: unknown = value.toJSON();
      return emitCanonical(normalized, emit, ancestors);
    }
    if (Array.isArray(value)) {
      emit("[");
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        if (index > 0) emit(",");
        // Preserve canonicalize's sparse-array and unsupported-value behavior.
        if (!(index in value)) continue;
        const item: unknown = value[index];
        emitCanonical(
          item === undefined || typeof item === "symbol" ? null : item,
          emit,
          ancestors,
        );
      }
      emit("]");
    } else {
      emit("{");
      let first = true;
      for (const key of Object.keys(value).sort()) {
        if (
          Reflect.get(value, key) === undefined ||
          typeof Reflect.get(value, key) === "symbol"
        )
          continue;
        const item: unknown = Reflect.get(value, key);
        if (!first) emit(",");
        first = false;
        emit(JSON.stringify(key));
        emit(":");
        if (!emitCanonical(item, emit, ancestors)) emit("undefined");
      }
      emit("}");
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
};
