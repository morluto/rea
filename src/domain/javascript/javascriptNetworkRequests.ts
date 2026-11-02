import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import { globalReferenceNamespace } from "./javascriptSemanticGlobalReference.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import * as t from "@babel/types";
import {
  createGlobalReferenceReader,
  semanticAmbientPathMayHaveChangedAt,
} from "./javascriptSemanticAmbientWrites.js";

const networkReaders = new WeakMap<
  JavaScriptSemanticAnalysisState,
  Map<string, ReturnType<typeof createGlobalReferenceReader>>
>();

const networkReferenceStatus = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  path: readonly [string, ...string[]],
): ReturnType<ReturnType<typeof createGlobalReferenceReader>>["status"] => {
  let readers = networkReaders.get(bindings);
  if (readers === undefined) {
    readers = new Map();
    networkReaders.set(bindings, readers);
  }
  const key = path.join(".");
  let reader = readers.get(key);
  if (reader === undefined) {
    reader = createGlobalReferenceReader(bindings, path);
    readers.set(key, reader);
  }
  const status = reader(callee).status;
  return status === "unmodified" &&
    semanticOpaqueGlobalMayHaveChanged(callee, bindings)
    ? "unknown"
    : status;
};

export const fetchReferenceStatus = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): ReturnType<ReturnType<typeof createGlobalReferenceReader>>["status"] =>
  networkReferenceStatus(callee, bindings, ["fetch"]);

export const browserNetworkReferenceStatus = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
): ReturnType<ReturnType<typeof createGlobalReferenceReader>>["status"] => {
  const paths: readonly (readonly [string, ...string[]])[] = t.isNewExpression(
    node,
  )
    ? [["WebSocket"], ["EventSource"]]
    : [["fetch"], ["navigator", "sendBeacon"]];
  for (const path of paths) {
    const status = networkReferenceStatus(node.callee, bindings, path);
    if (status !== "unrelated") return status;
  }
  return "unrelated";
};

export const isFetchCall = (
  node: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): boolean =>
  (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
  fetchReferenceStatus(node.callee, bindings) === "unmodified";

/** Browser request identity requires an intact intrinsic, not a method spelling. */
export const isBrowserNetworkRequest = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
): boolean => browserNetworkReferenceStatus(node, bindings) === "unmodified";

const isXhrOpenRequest = (
  node: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  index?: Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">,
): boolean | "unknown" | undefined => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) ||
    semanticStaticPropertyName(callee.property, callee.computed) !== "open"
  )
    return false;
  let receiver = unwrapJavaScriptExpression(callee.object).node;
  const seen = new Set<string>();
  let receiverMayHaveChanged = false;
  while (t.isIdentifier(receiver)) {
    if (
      index !== undefined &&
      (index.referenceMayHaveChangedAt(node, receiver, ["open"]) ||
        index.referenceMayHaveChangedAt(node, receiver, ["__proto__"]))
    )
      receiverMayHaveChanged = true;
    const binding = resolveSemanticBindingState(
      bindings,
      receiver,
      receiver.name,
    );
    if (binding === undefined || seen.has(binding.bindingId)) return false;
    seen.add(binding.bindingId);
    const initializer = semanticStableInitializer(binding, bindings);
    if (
      initializer !== undefined &&
      initializer.projection.length === 0 &&
      t.isNewExpression(initializer.node) &&
      globalReferenceNamespace(initializer.node.callee, bindings, [
        "XMLHttpRequest",
      ]) !== undefined &&
      semanticOpaqueGlobalMayHaveChanged(callee, bindings)
    )
      return "unknown";
    if (initializer === undefined || initializer.projection.length !== 0)
      return false;
    if (
      !semanticBindingAtRead(binding, receiver, bindings.parentsByNode)
        .hasDefiniteInitializer
    ) {
      // Nested activation may occur before or after initialization or mutation.
      // Preserve uncertainty only when the retained initializer identifies XHR.
      if (
        t.isNewExpression(initializer.node) &&
        globalReferenceNamespace(initializer.node.callee, bindings, [
          "XMLHttpRequest",
        ]) !== undefined
      )
        return "unknown";
      return false;
    }
    receiver = unwrapJavaScriptExpression(initializer.node).node;
  }
  if (!t.isNewExpression(receiver)) return false;
  if (
    globalReferenceNamespace(receiver.callee, bindings, ["XMLHttpRequest"]) ===
    undefined
  )
    return false;
  if (index === undefined && seen.size > 0) return undefined;
  if (
    receiverMayHaveChanged ||
    networkReferenceStatus(receiver.callee, bindings, ["XMLHttpRequest"]) !==
      "unmodified" ||
    semanticOpaqueGlobalMayHaveChanged(callee, bindings) ||
    ["XMLHttpRequest", "Object"].some((owner) =>
      ["open", "__proto__"].some((member) =>
        semanticAmbientPathMayHaveChangedAt(
          bindings,
          ["global", owner, "prototype", member],
          node,
        ),
      ),
    )
  )
    return "unknown";
  return true;
};

/** Resolve once through the shared mutation index when lexical proof needs it. */
export const createXhrOpenRequestQuery =
  (index: JavaScriptBindingIndex): ((node: t.Node) => boolean | "unknown") =>
  (node) => {
    const proof = isXhrOpenRequest(node, index.bindings);
    if (proof !== undefined) return proof;
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    return isXhrOpenRequest(node, index.bindings, index) ?? "unknown";
  };
