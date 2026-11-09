import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticConstructedReceiver,
  semanticPrimitiveArguments,
} from "./javascriptSemanticIntrinsicReceivers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import * as t from "@babel/types";
import {
  isUnmodifiedGlobalReference,
  semanticAmbientPathMayHaveChangedAt,
} from "./javascriptSemanticAmbientWrites.js";

export const isFetchCall = (
  node: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): boolean =>
  (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
  isUnmodifiedGlobalReference(node.callee, bindings, "fetch");

/** Browser request identity requires an intact intrinsic, not a method spelling. */
export const isBrowserNetworkRequest = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
): boolean =>
  isFetchCall(node, bindings) ||
  (t.isNewExpression(node) &&
    (isUnmodifiedGlobalReference(node.callee, bindings, "WebSocket") ||
      isUnmodifiedGlobalReference(node.callee, bindings, "EventSource"))) ||
  ((t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
    isUnmodifiedGlobalReference(node.callee, bindings, [
      "navigator",
      "sendBeacon",
    ]));

const isXhrOpenRequest = (
  node: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
  purpose: "request" | "receiver" = "request",
): boolean | undefined => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) ||
    semanticStaticPropertyName(callee.property, callee.computed) !== "open"
  )
    return false;
  // Native open can dispatch readystatechange. Its receiver is nonescaping
  // only when no handler or prior opaque operation can have configured it.
  // Primitive arguments also avoid user code during WebIDL string conversion.
  if (
    purpose === "receiver" &&
    !semanticPrimitiveArguments(node.arguments, bindings)
  )
    return false;
  const prototypeOwners =
    purpose === "receiver"
      ? ["XMLHttpRequest", "XMLHttpRequestEventTarget", "EventTarget", "Object"]
      : ["XMLHttpRequest", "Object"];
  if (
    prototypeOwners.some((owner) =>
      (purpose === "receiver"
        ? ["open", "__proto__", "onreadystatechange"]
        : ["open", "__proto__"]
      ).some((member) =>
        semanticAmbientPathMayHaveChangedAt(
          purpose === "receiver" ? node : callee,
          bindings,
          ["global", owner, "prototype", member],
          node,
        ),
      ),
    )
  )
    return false;
  const receiver = semanticConstructedReceiver(callee.object, node, bindings, {
    paths: purpose === "receiver" ? [[]] : [["open"], ["__proto__"]],
    index,
  });
  if (
    receiver === undefined ||
    !isUnmodifiedGlobalReference(
      receiver.construction.callee,
      bindings,
      "XMLHttpRequest",
    ) ||
    semanticOpaqueGlobalMayHaveChanged(callee, bindings)
  )
    return false;
  return index === undefined && receiver.viaBinding ? undefined : true;
};

/** A pristine native open is safe for the mutation producer, not every XHR call. */
export const isIntrinsicNonEscapingXhrOpen = (
  node: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
): boolean | undefined => isXhrOpenRequest(node, bindings, index, "receiver");

/** Resolve once through the shared mutation index when lexical proof needs it. */
export const createXhrOpenRequestQuery =
  (index: JavaScriptBindingIndex): ((node: t.Node) => boolean) =>
  (node) => {
    const proof = isXhrOpenRequest(node, index.bindings);
    if (proof !== undefined) return proof;
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    return isXhrOpenRequest(node, index.bindings, index) === true;
  };
