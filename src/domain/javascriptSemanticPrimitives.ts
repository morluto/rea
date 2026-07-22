import * as t from "@babel/types";

import type {
  JavaScriptSemanticPrimitive,
  JavaScriptSemanticValue,
} from "./javascriptSemanticIr.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import {
  reachSemanticValueLimit,
  semanticPrimitiveKey,
} from "./javascriptSemanticProvenance.js";
import { compareCodePoints } from "./javascriptStaticAnalysisHelpers.js";

/** Normalize one bounded collection of possible primitive values. */
export const semanticPrimitiveSet = (
  values: readonly JavaScriptSemanticPrimitive[],
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticValue => {
  const unique = [
    ...new Map(
      values.map((value) => [semanticPrimitiveKey(value), value]),
    ).values(),
  ].sort((left, right) =>
    compareCodePoints(semanticPrimitiveKey(left), semanticPrimitiveKey(right)),
  );
  if (unique.length > state.limits.maxUnionValues) {
    reachSemanticValueLimit(state, "maxUnionValues");
    return {
      status: "limit-reached",
      reason: "maxUnionValues reached.",
    };
  }
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
  if (t.isStringLiteral(node) || t.isNumericLiteral(node))
    return { found: true, value: node.value };
  if (t.isBooleanLiteral(node)) return { found: true, value: node.value };
  if (t.isNullLiteral(node)) return { found: true, value: null };
  return { found: false };
};
