import * as t from "@babel/types";

import {
  javaScriptExpressionResultIsUsed,
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
  semanticPristineArrayConstruction,
  semanticPristineEmptyMapConstruction,
} from "./javascriptSemanticIntrinsicReceivers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

const PRISTINE_OBJECT_METHODS = new Set([
  "hasOwnProperty",
  "propertyIsEnumerable",
  "isPrototypeOf",
  "toString",
  "toLocaleString",
  "valueOf",
]);

/** Object prototype methods on proven fresh receivers cannot expose shared hooks. */
export const isIntrinsicNonEscapingObjectCall = (
  node: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
): boolean | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const method = semanticStaticPropertyName(callee.property, callee.computed);
  if (
    !PRISTINE_OBJECT_METHODS.has(method ?? "") ||
    // valueOf returns the receiver; no returned-reference proof is added here.
    (method === "valueOf" &&
      javaScriptExpressionResultIsUsed(node, state.parentsByNode)) ||
    // Property keys can coerce, and isPrototypeOf can walk a Proxy argument.
    !semanticPrimitiveArguments(node.arguments, state)
  )
    return false;
  const receiver = semanticConstructedReceiver(callee.object, node, state, {
    paths: [[]],
    index,
  });
  if (receiver === undefined) return false;
  if (
    isUnmodifiedGlobalReference(receiver.construction.callee, state, "Array")
  ) {
    // Arrays override both string methods; their contracts belong to Array operations.
    if (
      method === "toString" ||
      method === "toLocaleString" ||
      !semanticPristineArrayConstruction(receiver.construction, node, state)
    )
      return false;
    return index === undefined ? undefined : true;
  }
  if (isUnmodifiedGlobalReference(receiver.construction.callee, state, "Map")) {
    if (
      !semanticPristineEmptyMapConstruction(receiver.construction, node, state)
    )
      return false;
    return index === undefined ? undefined : true;
  }
  if (
    !isUnmodifiedGlobalReference(
      receiver.construction.callee,
      state,
      "Object",
    ) ||
    receiver.construction.arguments.length !== 0
  )
    return false;
  // Include argument evaluation and the whole prototype surface: toString
  // reads Symbol.toStringTag, and toLocaleString invokes this.toString.
  if (
    semanticAmbientObjectMayHaveChangedAt(
      node,
      state,
      ["global", "Object", "prototype"],
      node,
    ) ||
    semanticOpaqueGlobalMayHaveChanged(node, state)
  )
    return false;
  // Direct constructions also wait for propagated effects and convergence.
  return index === undefined ? undefined : true;
};
