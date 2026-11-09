import * as t from "@babel/types";

import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isUnmodifiedGlobalReference,
  semanticAmbientObjectMayHaveChangedAt,
} from "./javascriptSemanticAmbientWrites.js";
import {
  semanticConstructedReceiver,
  semanticPrimitiveArguments,
} from "./javascriptSemanticIntrinsicReceivers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

const PRISTINE_ARRAY_METHODS = new Set([
  "fill",
  "copyWithin",
  "reverse",
  "push",
  "pop",
  "shift",
  "unshift",
  "includes",
  "indexOf",
  "lastIndexOf",
  "at",
  "join",
  "toString",
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
  if (
    (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) ||
    !PRISTINE_ARRAY_METHODS.has(
      semanticStaticPropertyName(callee.property, callee.computed) ?? "",
    ) ||
    // Some results retain this (including iterators); no returned-reference
    // proof is introduced even for methods whose result is primitive.
    !t.isExpressionStatement(state.parentsByNode.get(node))
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
    !isUnmodifiedGlobalReference(
      receiver.construction.callee,
      state,
      "Array",
    ) ||
    !semanticPrimitiveArguments(receiver.construction.arguments, state)
  )
    return false;
  // Holes may select inherited numeric accessors, not only the named method.
  // Include argument evaluation, which runs before the native mutation begins.
  if (
    ["Array", "Object"].some((owner) =>
      semanticAmbientObjectMayHaveChangedAt(
        node,
        state,
        ["global", owner, "prototype"],
        node,
      ),
    ) ||
    semanticOpaqueGlobalMayHaveChanged(node, state)
  )
    return false;
  // Even direct constructions wait for propagated effects and convergence.
  return index === undefined ? undefined : true;
};
