import type {
  JavaScriptSemanticResourceLimit,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";

import {
  JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
  type JavaScriptSemanticPrecision,
} from "./javascriptSemanticPrecision.js";

const resourceControls = {
  "primitive-candidates": ["primitive_candidates", "items", "alternatives"],
  "primitive-bytes": ["primitive_bytes", "bytes", "estimated JSON bytes"],
  "expression-depth": ["expression_depth", "depth", "nested expressions"],
  "getter-expansion": ["getter_expansions", "items", "scheduled states"],
  "alias-selections": [
    "alias_selections",
    "items",
    "additional selector states",
  ],
} as const;

/** One owner maps exhaustion classes to controls and effective coverage facts. */
export const semanticResourceLimitFacts = (
  resourceLimit: JavaScriptSemanticResourceLimit,
  precision: JavaScriptSemanticPrecision = JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
) => {
  const [control, unit, displayUnit] = resourceControls[resourceLimit];
  return {
    control,
    unit,
    displayUnit,
    value: precision[control],
    defaultValue: JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS[control],
  };
};

/** Exact caller control and effective value at the evaluator boundary. */
export const semanticResourceLimitReason = (
  resourceLimit: JavaScriptSemanticResourceLimit,
  precision: JavaScriptSemanticPrecision = JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
): string => {
  const { control, displayUnit, value, defaultValue } =
    semanticResourceLimitFacts(resourceLimit, precision);
  const prefixes = {
    "primitive-candidates": `Primitive candidate budget exceeded (maximum ${String(precision.primitive_candidates)} alternatives).`,
    "primitive-bytes": `Primitive string-byte budget exceeded (maximum ${String(precision.primitive_bytes)} estimated JSON bytes).`,
    "expression-depth": `Semantic expression depth budget exceeded (maximum ${String(precision.expression_depth)} nested expressions).`,
    "getter-expansion": `Getter expansion was conservatively bounded (maximum ${String(precision.getter_expansions)} scheduled states or a growing receiver cycle).`,
    "alias-selections": `Alias selection expansion was conservatively bounded (maximum ${String(precision.alias_selections)} additional selector states); selected paths remain unknown.`,
  };
  return `${prefixes[resourceLimit]} Semantic ${resourceLimit} budget reached: semantic_precision.${control}=${String(value)} ${displayUnit} (default ${String(defaultValue)}). Increase semantic_precision.${control} on the next analysis call (analyze_javascript_application or analyze_web_bundle), or pass --semantic-precision JSON on the CLI; no REA restart is required. Worker memory, transfer and graph-retention limits remain independent. Cyclic or unsupported evaluations remain unknown regardless of budget.`;
};

/** Check UTF-16 length against worst-case JSON escaping without flattening. */
const jsonStringBytesFromLength = (codeUnits: number): number =>
  codeUnits * 6 + 2;

/** Bound string payload before JSON key serialization or candidate creation. */
export const exceedsSemanticPrimitiveStringByteBudget = (
  strings: Iterable<string>,
  precision: JavaScriptSemanticPrecision = JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
): boolean => {
  let total = 0;
  for (const value of strings) {
    total += jsonStringBytesFromLength(value.length);
    if (total > precision.primitive_bytes) return true;
  }
  return false;
};

/** Bound all outputs of a primitive addition before concatenating any. */
export const exceedsSemanticPrimitiveAdditionByteBudget = (
  left: readonly (string | number | boolean | null)[],
  right: readonly (string | number | boolean | null)[],
  precision: JavaScriptSemanticPrecision = JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
): boolean => {
  let total = 0;
  for (const leftValue of left) {
    for (const rightValue of right) {
      if (typeof leftValue !== "string" && typeof rightValue !== "string")
        continue;
      const length = String(leftValue).length + String(rightValue).length;
      total += jsonStringBytesFromLength(length);
      if (total > precision.primitive_bytes) return true;
    }
  }
  return false;
};

/** Bound template interpolation outputs before creating concatenated strings. */
export const exceedsSemanticTemplateByteBudget = (
  prefixes: readonly string[],
  suffixes: readonly string[],
  precision: JavaScriptSemanticPrecision = JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
): boolean => {
  let total = 0;
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      total += jsonStringBytesFromLength(prefix.length + suffix.length);
      if (total > precision.primitive_bytes) return true;
    }
  }
  return false;
};

/** Make an explicit unknown value tagged with its effective semantic bound. */
export const semanticResourceLimitUnknown = (
  resourceLimit: JavaScriptSemanticResourceLimit,
  precision: JavaScriptSemanticPrecision = JAVASCRIPT_SEMANTIC_PRECISION_DEFAULTS,
): JavaScriptSemanticValue => ({
  status: "unknown",
  reason: semanticResourceLimitReason(resourceLimit, precision),
  resourceLimit,
});
