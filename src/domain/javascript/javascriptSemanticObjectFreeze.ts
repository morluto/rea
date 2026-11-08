import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  globalReferenceNamespace,
  isUnmodifiedGlobalReference,
} from "./javascriptSemanticGlobalReference.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

const isImmutableConstOrFunctionBinding = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  sourceType?: t.Program["sourceType"],
): boolean => {
  if (binding.mutable) return false;
  if (
    binding.kind === "variable" &&
    binding.declarationKinds.size === 1 &&
    binding.declarationKinds.has("const")
  )
    return true;
  if (
    binding.kind === "function" &&
    binding.declarationKinds.size === 0 &&
    binding.definitions.length === 1 &&
    binding.definitions[0]?.kind === "function"
  ) {
    // Classic-script top-level function declarations mirror onto the global
    // object, so an ambient property write can replace the function binding.
    if (
      sourceType !== "module" &&
      binding.scopeId.startsWith("scope:program:") &&
      state.ambientWrites.covers(["global", binding.name])
    )
      return false;
    return true;
  }
  return false;
};

/** Resolve one definite non-rebindable lexical initializer at a read site. */
export const immutableLexicalInitializerAtRead = (
  identifier: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
  sourceType?: t.Program["sourceType"],
):
  | {
      readonly binding: JavaScriptSemanticBindingState;
      readonly node: t.Node;
    }
  | undefined => {
  const binding = resolveSemanticBindingState(
    state,
    identifier,
    identifier.name,
  );
  if (
    binding === undefined ||
    !isImmutableConstOrFunctionBinding(binding, state, sourceType)
  )
    return undefined;
  const initializer = semanticStableInitializer(binding, state);
  if (
    initializer === undefined ||
    initializer.projection.length !== 0 ||
    !semanticBindingAtRead(binding, identifier, state).hasDefiniteInitializer
  )
    return undefined;
  return { binding, node: initializer.node };
};

/**
 * Return the single target expression of an unmodified intrinsic `Object.freeze`
 * call, or `undefined` when global identity, escapes, or call arity leave its
 * behavior uncertain.
 */
export const unwrapUnmodifiedObjectFreezeArgument = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Expression | undefined => {
  const call = unwrapJavaScriptExpression(node).node;
  if (!t.isCallExpression(call) && !t.isOptionalCallExpression(call))
    return undefined;
  if (call.arguments.length !== 1) return undefined;
  const callee = unwrapJavaScriptExpression(call.callee).node;
  if (
    (!t.isMemberExpression(callee) && !t.isOptionalMemberExpression(callee)) ||
    semanticStaticPropertyKey(callee.property, callee.computed) !== "freeze"
  )
    return undefined;
  const [argument] = call.arguments;
  if (argument === undefined || !t.isExpression(argument)) return undefined;
  if (!isUnmodifiedGlobalReference(call.callee, state, ["Object", "freeze"]))
    return undefined;
  if (state.ambientEscapes.covers(["global", "Object", "freeze"]))
    return undefined;
  const namespace = globalReferenceNamespace(call.callee, state, [
    "Object",
    "freeze",
  ]);
  if (
    namespace !== undefined &&
    namespace !== null &&
    state.ambientEscapes.covers(["global", namespace, "Object", "freeze"])
  )
    return undefined;
  if (semanticOpaqueGlobalMayHaveChanged(call.callee, state)) return undefined;
  return argument;
};

/**
 * Ordinary ECMAScript object literals and functions have fixed internal
 * integrity-level methods (`[[PreventExtensions]]`, `[[OwnPropertyKeys]]`,
 * `[[GetOwnProperty]]`, `[[DefineOwnProperty]]`) that never invoke accessors,
 * prototype hooks, or user callbacks during `Object.freeze`. Targets that could
 * be `Proxy` or `TypedArray` instances are excluded.
 */
export const isIntrinsicOrdinaryObjectFreezeCall = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const argument = unwrapUnmodifiedObjectFreezeArgument(node, state);
  if (argument === undefined) return false;
  let current: t.Node = unwrapJavaScriptExpression(argument).node;
  const seenNodes = new Set<t.Node>();
  const seenBindings = new Set<string>();
  for (;;) {
    if (seenNodes.has(current)) return false;
    seenNodes.add(current);
    const frozen = unwrapUnmodifiedObjectFreezeArgument(current, state);
    if (frozen !== undefined) {
      current = unwrapJavaScriptExpression(frozen).node;
      continue;
    }
    if (!t.isIdentifier(current)) break;
    const resolved = immutableLexicalInitializerAtRead(current, state);
    if (resolved === undefined || seenBindings.has(resolved.binding.bindingId))
      return false;
    seenBindings.add(resolved.binding.bindingId);
    current = unwrapJavaScriptExpression(resolved.node).node;
  }
  return t.isObjectExpression(current) || t.isFunction(current);
};
