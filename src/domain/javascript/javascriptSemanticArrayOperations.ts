import * as t from "@babel/types";

import {
  javaScriptExpressionResultIsUsed,
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticConstructedReceiver,
  semanticPrimitiveArguments,
  semanticPristineArrayConstruction,
} from "./javascriptSemanticIntrinsicReceivers.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

// Primitive-only construction and prior admitted mutations cannot add object slots.
const PRISTINE_ARRAY_PRIMITIVE_RESULTS = new Set([
  "includes",
  "indexOf",
  "lastIndexOf",
  "at",
  "join",
  "toString",
  "push",
  "pop",
  "shift",
  "unshift",
]);
const PRISTINE_ARRAY_RETAINED_RESULTS = new Set([
  "fill",
  "copyWithin",
  "reverse",
  "keys",
  "values",
  "entries",
]);

/** These native operations have no callbacks on pristine arrays with primitive arguments. */
export const isIntrinsicNonEscapingArrayCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
): boolean | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const method =
    semanticStaticPropertyName(callee.property, callee.computed) ?? "";
  if (
    !PRISTINE_ARRAY_PRIMITIVE_RESULTS.has(method) &&
    (!PRISTINE_ARRAY_RETAINED_RESULTS.has(method) ||
      // Receiver-returning methods and iterators retain the array itself.
      javaScriptExpressionResultIsUsed(node, state.parentsByNode))
  )
    return false;
  if (!semanticPrimitiveArguments(node.arguments, state)) return false;
  const receiver = semanticConstructedReceiver(callee.object, node, state, {
    paths: [[]],
    index,
  });
  // Literal arrays retain element values. Skipping their mutation without a
  // value update would restore stale slots; new Array already evaluates unknown.
  if (
    receiver === undefined ||
    !semanticPristineArrayConstruction(receiver.construction, node, state)
  )
    return false;
  // Even direct constructions wait for propagated effects and convergence.
  return index === undefined ? undefined : true;
};
