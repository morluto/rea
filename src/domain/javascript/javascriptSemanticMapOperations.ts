import * as t from "@babel/types";

import {
  javaScriptExpressionResultIsUsed,
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isUnmodifiedGlobalReference,
  semanticAmbientPathMayHaveChangedAt,
} from "./javascriptSemanticAmbientWrites.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import { semanticConstructedReceiver } from "./javascriptSemanticIntrinsicReceivers.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

/** Prove an unchanged Map operation; undefined requests shared member-mutation facts. */
const isIntrinsicMapOperation = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
  purpose: "lookup" | "receiver",
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
): boolean | undefined => {
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee))
    return false;
  const method = semanticStaticPropertyName(callee.property, callee.computed);
  if (
    method !== "get" &&
    method !== "delete" &&
    (purpose !== "receiver" ||
      (method !== "has" &&
        method !== "clear" &&
        // set returns this, and iterators retain entries. Until their result
        // identities are retained, only discarded results prove no escape.
        ((method !== "set" &&
          method !== "keys" &&
          method !== "values" &&
          method !== "entries") ||
          javaScriptExpressionResultIsUsed(node, bindings.parentsByNode))))
  )
    return false;
  const prototypeMemberMayHaveChanged = (
    member: string,
    read: t.Node,
    invocation: t.Node,
  ): boolean =>
    ["Map", "Object"].some((owner) =>
      semanticAmbientPathMayHaveChangedAt(
        read,
        bindings,
        ["global", owner, "prototype", member],
        invocation,
      ),
    );
  if (prototypeMemberMayHaveChanged(method, callee, node)) return false;
  const receiver = semanticConstructedReceiver(callee.object, node, bindings, {
    paths: [[method], ["__proto__"]],
    index,
  });
  if (
    receiver === undefined ||
    !isUnmodifiedGlobalReference(receiver.construction.callee, bindings, "Map")
  )
    return false;
  // Iterable construction reads and invokes the instance's set hook. A changed
  // adder can install its own get/delete before the constructed value is read.
  // The adder is selected after arguments evaluate, not at the callee read.
  if (
    receiver.construction.arguments.length > 0 &&
    prototypeMemberMayHaveChanged(
      "set",
      receiver.construction,
      receiver.construction,
    )
  )
    return false;
  if (semanticOpaqueGlobalMayHaveChanged(callee, bindings)) return false;
  return index === undefined && receiver.viaBinding ? undefined : true;
};

/** Endpoint filtering applies only to the route-like get/delete methods. */
export const isIntrinsicMapLookup = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
): boolean | undefined =>
  isIntrinsicMapOperation(node, bindings, "lookup", index);

/** Other callback-free native methods also leave the shared class untouched. */
export const isIntrinsicNonEscapingMapCall = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
): boolean | undefined =>
  isIntrinsicMapOperation(node, bindings, "receiver", index);
