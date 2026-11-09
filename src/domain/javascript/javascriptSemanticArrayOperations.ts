import * as t from "@babel/types";

import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isUnmodifiedGlobalReference,
  semanticAmbientObjectMayHaveChangedAt,
} from "./javascriptSemanticAmbientWrites.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import { semanticPrimitiveCandidates } from "./javascriptSemanticPrimitives.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

const PRISTINE_ARRAY_METHODS = new Set([
  "fill",
  "copyWithin",
  "reverse",
  "push",
  "pop",
  "shift",
  "unshift",
]);

/** These native mutations have no callbacks on pristine arrays with primitive arguments. */
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
    // Some methods return this; no returned-reference proof is introduced here.
    !t.isExpressionStatement(state.parentsByNode.get(node))
  )
    return false;
  const primitiveArguments = (arguments_: typeof node.arguments): boolean =>
    arguments_.every(
      (argument) =>
        !t.isSpreadElement(argument) &&
        semanticPrimitiveCandidates(
          evaluateSemanticExpression(argument, state),
        ) !== null,
    );
  if (!primitiveArguments(node.arguments)) return false;
  let receiver = unwrapJavaScriptExpression(callee.object).node;
  const seen = new Set<string>();
  while (t.isIdentifier(receiver)) {
    if (index?.referenceMayHaveChangedAt(node, receiver, [])) return false;
    const binding = resolveSemanticBindingState(state, receiver, receiver.name);
    if (binding === undefined || seen.has(binding.bindingId)) return false;
    seen.add(binding.bindingId);
    const initializer = semanticStableInitializer(binding, state);
    if (
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      !semanticBindingAtRead(binding, receiver, state).hasDefiniteInitializer
    )
      return false;
    receiver = unwrapJavaScriptExpression(initializer.node).node;
  }
  // Literal arrays retain element values. Skipping their mutation without a
  // value update would restore stale slots; new Array already evaluates unknown.
  if (
    !t.isNewExpression(receiver) ||
    !isUnmodifiedGlobalReference(receiver.callee, state, "Array") ||
    !primitiveArguments(receiver.arguments)
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
