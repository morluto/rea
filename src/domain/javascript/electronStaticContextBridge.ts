import * as t from "@babel/types";

import type { ElectronContextBridgeFinding } from "./electronStaticAnalysisTypes.js";
import {
  collectContextBridgeMembers,
  contextBridgeMemberPathDepth,
  createContextBridgeMemberBudget,
  type ContextBridgeMemberBudget,
  type ContextBridgeNestedPropertyResolution,
} from "./electronStaticAnalysisValues.js";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  immutableLexicalInitializerAtRead,
  unwrapUnmodifiedObjectFreezeArgument,
} from "./javascriptSemanticObjectFreeze.js";
import type {
  JavaScriptBindingIndex,
  JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { javascriptSourceRangeKey } from "./javascriptSourceCoordinates.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import type { JavaScriptSourceRange } from "./javascriptStaticAnalysisTypes.js";

/** Defer contextBridge APIs whose root or nested object values may resolve via bindings or Object.freeze. */
export const needsDeferredContextBridgeApi = (
  apiNode: t.Node | undefined,
  depth = 0,
): boolean => {
  if (apiNode === undefined || depth > contextBridgeMemberPathDepth)
    return false;
  const unwrapped = unwrapJavaScriptExpression(apiNode).node;
  if (
    t.isIdentifier(unwrapped) ||
    t.isCallExpression(unwrapped) ||
    t.isOptionalCallExpression(unwrapped)
  )
    return true;
  if (!t.isObjectExpression(unwrapped) || depth >= contextBridgeMemberPathDepth)
    return false;
  return unwrapped.properties.some(
    (property) =>
      t.isObjectProperty(property) &&
      needsDeferredContextBridgeApi(property.value, depth + 1),
  );
};

/** Avoid indexing member-mutation facts unless at least one binding or Object.freeze candidate exists. */
export const hasContextBridgeResolutionCandidate = (
  apiNode: t.Node | undefined,
  index: JavaScriptBindingIndex,
  depth = 0,
): boolean => {
  if (apiNode === undefined || depth > contextBridgeMemberPathDepth)
    return false;
  const unwrapped = unwrapJavaScriptExpression(apiNode).node;
  const frozen = unwrapUnmodifiedObjectFreezeArgument(
    unwrapped,
    index.bindings,
  );
  if (frozen !== undefined) return true;
  if (t.isIdentifier(unwrapped))
    return (
      immutableLexicalInitializerAtRead(
        unwrapped,
        index.bindings,
        index.sourceType,
      ) !== undefined
    );
  if (!t.isObjectExpression(unwrapped) || depth >= contextBridgeMemberPathDepth)
    return false;
  return unwrapped.properties.some(
    (property) =>
      t.isObjectProperty(property) &&
      hasContextBridgeResolutionCandidate(property.value, index, depth + 1),
  );
};

const expressionMayProduceObjectLiteral = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  seen = new Set<t.Node>(),
): boolean => {
  const current = unwrapJavaScriptExpression(node).node;
  if (seen.has(current)) return false;
  seen.add(current);
  if (t.isObjectExpression(current)) return true;
  const frozen = unwrapUnmodifiedObjectFreezeArgument(current, state);
  if (frozen !== undefined)
    return expressionMayProduceObjectLiteral(frozen, state, seen);
  if (t.isConditionalExpression(current))
    return (
      expressionMayProduceObjectLiteral(current.consequent, state, seen) ||
      expressionMayProduceObjectLiteral(current.alternate, state, seen)
    );
  if (t.isLogicalExpression(current))
    return (
      expressionMayProduceObjectLiteral(current.left, state, seen) ||
      expressionMayProduceObjectLiteral(current.right, state, seen)
    );
  if (t.isSequenceExpression(current)) {
    const last = current.expressions.at(-1);
    return last !== undefined
      ? expressionMayProduceObjectLiteral(last, state, seen)
      : false;
  }
  return false;
};

type ExpressionResolution =
  | {
      readonly kind: "object";
      readonly object: t.ObjectExpression;
      readonly activeNodes: ReadonlySet<t.Node>;
      readonly substituted: boolean;
    }
  | {
      readonly kind: "function";
      readonly fn: t.Function;
      readonly substituted: boolean;
    }
  | { readonly kind: "invalid-or-cyclic" }
  | { readonly kind: "non-object-leaf" };

const resolveContextBridgeValue = (
  input: t.Node,
  site: t.Node,
  index: JavaScriptBindingIndex,
  activeNodes: ReadonlySet<t.Node>,
  budget: ContextBridgeMemberBudget,
): ExpressionResolution => {
  let current = unwrapJavaScriptExpression(input).node;
  const nextActive = new Set(activeNodes);
  const seenBindings = new Set<string>();
  let substituted = false;
  for (;;) {
    if (nextActive.has(current)) return { kind: "invalid-or-cyclic" };
    const frozen = unwrapUnmodifiedObjectFreezeArgument(
      current,
      index.bindings,
    );
    if (frozen !== undefined) {
      if (budget.remainingVisits <= 0) return { kind: "invalid-or-cyclic" };
      budget.remainingVisits -= 1;
      nextActive.add(current);
      substituted = true;
      current = unwrapJavaScriptExpression(frozen).node;
      continue;
    }
    if (!t.isIdentifier(current)) break;
    if (budget.remainingVisits <= 0) return { kind: "invalid-or-cyclic" };
    budget.remainingVisits -= 1;
    const binding = index.bindingForReferenceAt(current);
    if (binding === undefined) return { kind: "non-object-leaf" };
    if (seenBindings.has(binding.bindingId))
      return { kind: "invalid-or-cyclic" };
    seenBindings.add(binding.bindingId);
    const lexical = immutableLexicalInitializerAtRead(
      current,
      index.bindings,
      index.sourceType,
    );
    if (lexical === undefined) {
      const tdzConst =
        !binding.mutable &&
        binding.declarationKinds.has("const") &&
        !semanticBindingAtRead(binding, current, index.bindings)
          .hasDefiniteInitializer;
      const mutableObject = binding.initializers.some((init) =>
        expressionMayProduceObjectLiteral(init.node, index.bindings),
      );
      return tdzConst || mutableObject
        ? { kind: "invalid-or-cyclic" }
        : { kind: "non-object-leaf" };
    }
    if (index.referenceMayHaveChangedAt(site, current))
      return { kind: "invalid-or-cyclic" };
    nextActive.add(current);
    substituted = true;
    current = unwrapJavaScriptExpression(lexical.node).node;
  }
  if (t.isObjectExpression(current)) {
    if (nextActive.has(current)) return { kind: "invalid-or-cyclic" };
    nextActive.add(current);
    return {
      kind: "object",
      object: current,
      activeNodes: nextActive,
      substituted,
    };
  }
  if (
    t.isArrowFunctionExpression(current) ||
    t.isFunctionExpression(current) ||
    t.isFunctionDeclaration(current)
  )
    return { kind: "function", fn: current, substituted };
  return expressionMayProduceObjectLiteral(current, index.bindings)
    ? { kind: "invalid-or-cyclic" }
    : { kind: "non-object-leaf" };
};

/** Resolve a contextBridge API expression and any nested immutable const/frozen objects. */
export const resolveContextBridgeApi = (
  apiNode: t.Node | undefined,
  site: t.Node,
  index: JavaScriptBindingIndex,
  budget: ContextBridgeMemberBudget = createContextBridgeMemberBudget(),
): {
  readonly status: ElectronContextBridgeFinding["api_status"];
  readonly members: readonly string[];
  readonly unknown: number;
  readonly resolutionSources: readonly JavaScriptSourceRange[];
} => {
  if (apiNode === undefined)
    return {
      status: "missing",
      members: [],
      unknown: 0,
      resolutionSources: [],
    };
  const sourcesByKey = new Map<string, JavaScriptSourceRange>();
  const recordSource = (node: t.Node): void => {
    const location = range(node);
    const key = javascriptSourceRangeKey(location);
    if (!sourcesByKey.has(key)) sourcesByKey.set(key, location);
  };
  const root = resolveContextBridgeValue(
    apiNode,
    site,
    index,
    new Set(),
    budget,
  );
  if (root.kind === "function") {
    if (root.substituted) recordSource(root.fn);
    return {
      status: "function",
      members: [],
      unknown: 0,
      resolutionSources: [...sourcesByKey.values()],
    };
  }
  if (root.kind !== "object")
    return {
      status: "dynamic",
      members: [],
      unknown: 1,
      resolutionSources: [],
    };
  if (root.substituted) recordSource(root.object);
  const resolveNested = (
    value: t.Node,
    activeNodes: ReadonlySet<t.Node>,
  ): ContextBridgeNestedPropertyResolution => {
    const unwrapped = unwrapJavaScriptExpression(value).node;
    if (
      !t.isObjectExpression(unwrapped) &&
      !t.isIdentifier(unwrapped) &&
      unwrapUnmodifiedObjectFreezeArgument(unwrapped, index.bindings) ===
        undefined
    ) {
      return expressionMayProduceObjectLiteral(unwrapped, index.bindings)
        ? { kind: "unknown" }
        : { kind: "leaf" };
    }
    const resolved = resolveContextBridgeValue(
      value,
      site,
      index,
      new Set([...root.activeNodes, ...activeNodes]),
      budget,
    );
    if (resolved.kind === "object") {
      if (resolved.substituted) recordSource(resolved.object);
      return {
        kind: "object",
        object: resolved.object,
        activeNodes: resolved.activeNodes,
      };
    }
    if (resolved.kind === "function" || resolved.kind === "non-object-leaf")
      return { kind: "leaf" };
    return { kind: "unknown" };
  };
  const collected = collectContextBridgeMembers(
    root.object,
    resolveNested,
    budget,
  );
  return {
    ...collected,
    resolutionSources: [...sourcesByKey.values()],
  };
};
