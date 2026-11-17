import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import * as t from "@babel/types";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticGlobalReference.js";
import { isIntrinsicInstanceMethodCall } from "./javascriptSemanticIntrinsicInstances.js";

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
  index?: Pick<JavaScriptBindingIndex, "mayObserve">,
): boolean | undefined =>
  (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
  isIntrinsicInstanceMethodCall(
    node,
    bindings,
    { constructor: "XMLHttpRequest", methods: ["open"] },
    index,
  );

/** Resolve once through the shared mutation index when lexical proof needs it. */
export const createXhrOpenRequestQuery =
  (index: JavaScriptBindingIndex): ((node: t.Node) => boolean) =>
  (node) => {
    const proof = isXhrOpenRequest(node, index.bindings);
    if (proof !== undefined) return proof;
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    return isXhrOpenRequest(node, index.bindings, index) === true;
  };
