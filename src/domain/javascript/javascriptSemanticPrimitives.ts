import type {
  JavaScriptSemanticPrimitive,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { semanticPrimitiveKey } from "./javascriptSemanticProvenance.js";
import {
  SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT,
  SEMANTIC_PRIMITIVE_JSON_BYTES_LIMIT,
  SEMANTIC_PRIMITIVE_SAMPLE_SCOPE_LIMIT,
  exceedsSemanticPrimitiveStringByteBudget,
  semanticResourceLimitUnknown,
} from "./javascriptSemanticResourceLimits.js";

/**
 * Deterministically retain at most `SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT`
 * candidates from a sorted candidate scope. Sorting first makes the retained
 * subset independent of candidate arrival order, so adversarial shuffling
 * cannot influence which candidates survive.
 */
const samplePrimitiveCandidates = (
  sorted: readonly JavaScriptSemanticPrimitive[],
): readonly JavaScriptSemanticPrimitive[] => {
  // Evenly spaced positions covering the whole scope. The scope always
  // exceeds the candidate limit here, so consecutive positions are distinct.
  const sampled: JavaScriptSemanticPrimitive[] = [];
  for (let index = 0; index < SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT; index += 1) {
    const position = Math.floor(
      (index * sorted.length) / SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT,
    );
    const value = sorted[position];
    if (value !== undefined) sampled.push(value);
  }
  return sampled;
};

/** Normalize one bounded collection of possible primitive values. */
export const semanticPrimitiveSet = (
  values: readonly JavaScriptSemanticPrimitive[],
): JavaScriptSemanticValue => {
  let uniqueValues: Set<JavaScriptSemanticPrimitive> | undefined;
  for (const value of values) {
    if (typeof value === "number" && !Number.isFinite(value))
      return {
        status: "unknown",
        reason: "Nonfinite numbers are outside the JSON primitive lattice.",
      };
    if (typeof value === "number" && Object.is(value, -0))
      return {
        status: "unknown",
        reason: "Negative zero cannot be preserved by JSON primitive evidence.",
      };
    // The common literal path needs validation, but no deduplication, sorting
    // or canonical-key allocation. Check strings before retaining the value.
    if (values.length === 1)
      return typeof value === "string" &&
        exceedsSemanticPrimitiveStringByteBudget([value])
        ? semanticResourceLimitUnknown("primitive-bytes")
        : { status: "literal", value };
    uniqueValues ??= new Set<JavaScriptSemanticPrimitive>();
    uniqueValues.add(value);
    // Keep collecting distinct candidates past the candidate budget so a
    // modest overflow can be reported as a sampled union; bail only when the
    // hard sample-scope bound trips, which keeps deduplication and sorting
    // work bounded under adversarial candidate inflation.
    if (uniqueValues.size > SEMANTIC_PRIMITIVE_SAMPLE_SCOPE_LIMIT)
      return semanticResourceLimitUnknown("primitive-candidates");
  }
  if (uniqueValues === undefined) return { status: "union", values: [] };
  if (
    exceedsSemanticPrimitiveStringByteBudget(
      [...uniqueValues].flatMap((value) =>
        typeof value === "string" ? [value] : [],
      ),
    )
  )
    return semanticResourceLimitUnknown("primitive-bytes");
  const unique = [...uniqueValues]
    .map((value) => ({ key: semanticPrimitiveKey(value), value }))
    .sort((left, right) => compareUnicodeCodePoints(left.key, right.key))
    .map(({ value }) => value);
  const only = unique[0];
  if (unique.length === 1 && only !== undefined)
    return { status: "literal", value: only };
  if (unique.length <= SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT)
    return { status: "union", values: unique };
  return sampledUnionOrByteLimit(
    samplePrimitiveCandidates(unique),
    unique.length,
    SEMANTIC_PRIMITIVE_SAMPLE_METHOD,
  );
};

/** Read the primitive candidates retained in one lattice value. */
export const semanticPrimitiveCandidates = (
  value: JavaScriptSemanticValue,
): readonly JavaScriptSemanticPrimitive[] | null =>
  value.status === "literal"
    ? [value.value]
    : value.status === "union"
      ? value.values
      : null;

/**
 * Count the distinct candidates one lattice value stands for. Sampled unions
 * report their observed scope rather than their retained sample size so
 * downstream products and merges keep honest overflow accounting.
 */
export const semanticPrimitiveCandidateCount = (
  value: JavaScriptSemanticValue,
): number | null => {
  if (value.status === "literal") return 1;
  if (value.status !== "union") return null;
  return value.sampled?.seenCount ?? value.values.length;
};

const SEMANTIC_PRIMITIVE_SAMPLE_METHOD = "systematic-candidate-stride-v1";
const SEMANTIC_PRIMITIVE_PRODUCT_SAMPLE_METHOD = "grid-product-stride-v1";

/** Byte-check one retained sample before returning it as sampled evidence. */
const sampledUnionOrByteLimit = (
  retained: readonly JavaScriptSemanticPrimitive[],
  seenCount: number,
  method:
    | typeof SEMANTIC_PRIMITIVE_SAMPLE_METHOD
    | typeof SEMANTIC_PRIMITIVE_PRODUCT_SAMPLE_METHOD,
): JavaScriptSemanticValue => {
  // Validate and account while retaining: combined strings are checked
  // against the byte budget before they enter the dedup set, and nonfinite
  // numbers are rejected exactly like the exact-set path, so a sampled
  // result can never smuggle values the exact path would have refused.
  const uniqueRetained = new Set<JavaScriptSemanticPrimitive>();
  let stringBytes = 0;
  for (const value of retained) {
    if (typeof value === "number" && !Number.isFinite(value))
      return {
        status: "unknown",
        reason: "Nonfinite numbers are outside the JSON primitive lattice.",
      };
    // Charge the byte budget only for values that survive deduplication;
    // repeated samples of one string must not exhaust the budget on their own.
    if (typeof value === "string" && !uniqueRetained.has(value)) {
      stringBytes += value.length * 6 + 2;
      if (stringBytes > SEMANTIC_PRIMITIVE_JSON_BYTES_LIMIT)
        return semanticResourceLimitUnknown("primitive-bytes");
    }
    uniqueRetained.add(value);
  }
  return {
    status: "union",
    values: [...uniqueRetained],
    sampled: { method, seenCount },
  };
};

/**
 * Deterministically combine two candidate scopes without materializing their
 * Cartesian product. Evenly spaced grid positions keep the retained subset
 * independent of operand order and bound work at the candidate limit.
 */
export const semanticPrimitiveSampledProduct = (options: {
  left: readonly JavaScriptSemanticPrimitive[];
  right: readonly JavaScriptSemanticPrimitive[];
  combine: (
    left: JavaScriptSemanticPrimitive,
    right: JavaScriptSemanticPrimitive,
  ) => JavaScriptSemanticPrimitive;
  leftSeenCount: number;
  rightSeenCount: number;
}): JavaScriptSemanticValue => {
  const { left, right, combine, leftSeenCount, rightSeenCount } = options;
  // Keep the reported scope and the grid math finite no matter how large the
  // true product grows; deeply chained products saturate instead of producing
  // nonfinite positions the worker schema would reject. The reported scope is
  // the true product while it fits in a safe integer, then saturates.
  const exactTotal = leftSeenCount * rightSeenCount;
  const reported = Math.min(exactTotal, Number.MAX_SAFE_INTEGER);
  const retained: JavaScriptSemanticPrimitive[] = [];
  for (let index = 0; index < SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT; index += 1) {
    let leftScope: number;
    let rightScope: number;
    if (exactTotal <= Number.MAX_SAFE_INTEGER) {
      // Exact grid: one flat stride over the true product, decomposed into
      // per-axis scopes. With an exact total this covers both axes evenly.
      const flat = Math.floor(
        (index * exactTotal) / SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT,
      );
      leftScope = Math.floor(flat / rightSeenCount);
      rightScope = flat % rightSeenCount;
    } else {
      // Saturated product: a flat stride collapses onto a single axis (the
      // division floor pins one scope to zero). Stride each axis
      // independently instead, so both operands stay represented even when
      // one side dwarfs the other.
      leftScope = Math.floor(
        (index * leftSeenCount) / SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT,
      );
      rightScope = Math.floor(
        (index * rightSeenCount) / SEMANTIC_PRIMITIVE_CANDIDATE_LIMIT,
      );
    }
    // Scope positions may exceed the retained sample when an operand was
    // itself sampled; rescale into the retained array without clamping bias.
    const leftIndex = Math.floor((leftScope * left.length) / leftSeenCount);
    const rightIndex = Math.floor(
      (rightScope * right.length) / rightSeenCount,
    );
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (leftValue !== undefined && rightValue !== undefined)
      retained.push(combine(leftValue, rightValue));
  }
  return sampledUnionOrByteLimit(
    retained,
    reported,
    SEMANTIC_PRIMITIVE_PRODUCT_SAMPLE_METHOD,
  );
};