import * as t from "@babel/types";

import type {
  JavaScriptSemanticPrimitive,
  JavaScriptSemanticValue,
} from "./javascriptSemanticIr.js";
import { compareCodePoints } from "./canonicalOrdering.js";
import { semanticPrimitiveKey } from "./javascriptSemanticProvenance.js";

/** Normalize one bounded collection of possible primitive values. */
export const semanticPrimitiveSet = (
  values: readonly JavaScriptSemanticPrimitive[],
): JavaScriptSemanticValue => {
  if (
    values.some((value) => typeof value === "number" && !Number.isFinite(value))
  )
    return {
      status: "unknown",
      reason: "Nonfinite numbers are outside the JSON primitive lattice.",
    };
  const unique = [
    ...new Map(
      values.map((value) => [semanticPrimitiveKey(value), value]),
    ).values(),
  ].sort((left, right) =>
    compareCodePoints(semanticPrimitiveKey(left), semanticPrimitiveKey(right)),
  );
  const only = unique[0];
  return unique.length === 1 && only !== undefined
    ? { status: "literal", value: only }
    : { status: "union", values: unique };
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

/** Parse one Babel primitive literal without evaluating code. */
export const semanticPrimitiveValue = (
  node: t.Node,
):
  | { readonly found: true; readonly value: JavaScriptSemanticPrimitive }
  | { readonly found: false } => {
  if (t.isStringLiteral(node)) return { found: true, value: node.value };
  if (t.isNumericLiteral(node) && Number.isFinite(node.value))
    return { found: true, value: node.value };
  if (t.isBooleanLiteral(node)) return { found: true, value: node.value };
  if (t.isNullLiteral(node)) return { found: true, value: null };
  return { found: false };
};
