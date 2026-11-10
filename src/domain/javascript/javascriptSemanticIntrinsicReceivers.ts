import * as t from "@babel/types";

import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import {
  isUnmodifiedGlobalReference,
  semanticAmbientObjectMayHaveChangedAt,
} from "./javascriptSemanticAmbientWrites.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";
import { semanticPrimitiveCandidates } from "./javascriptSemanticPrimitives.js";
import type { JavaScriptSemanticPropertyPath } from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";

/** Resolve only stable, initialized identifier chains to one construction. */
export const semanticConstructedReceiver = (
  expression: t.Node,
  invocation: t.Node,
  state: JavaScriptSemanticAnalysisState,
  {
    paths,
    index,
  }: {
    readonly paths: readonly JavaScriptSemanticPropertyPath[];
    readonly index:
      | Pick<JavaScriptBindingIndex, "referenceMayHaveChangedAt">
      | undefined;
  },
):
  | { readonly construction: t.NewExpression; readonly viaBinding: boolean }
  | undefined => {
  let receiver = unwrapJavaScriptExpression(expression).node;
  const seen = new Set<string>();
  while (t.isIdentifier(receiver)) {
    if (
      index !== undefined &&
      paths.some((path) =>
        index.referenceMayHaveChangedAt(invocation, receiver, path),
      )
    )
      return undefined;
    const binding = resolveSemanticBindingState(state, receiver, receiver.name);
    if (binding === undefined || seen.has(binding.bindingId)) return undefined;
    seen.add(binding.bindingId);
    const initializer = semanticStableInitializer(binding, state);
    if (
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      !semanticBindingAtRead(binding, receiver, state).hasDefiniteInitializer
    )
      return undefined;
    receiver = unwrapJavaScriptExpression(initializer.node).node;
  }
  return t.isNewExpression(receiver)
    ? { construction: receiver, viaBinding: seen.size > 0 }
    : undefined;
};

/** Primitive candidates exclude coercion hooks; evaluating them can still have effects. */
export const semanticPrimitiveArguments = (
  arguments_: t.CallExpression["arguments"],
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  arguments_.every(
    (argument) =>
      !t.isSpreadElement(argument) &&
      semanticPrimitiveCandidates(
        evaluateSemanticExpression(argument, state),
      ) !== null,
  );

/** Fresh primitive arrays cannot retain object slots or select modified prototype hooks. */
export const semanticPristineArrayConstruction = (
  construction: t.NewExpression,
  invocation: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isUnmodifiedGlobalReference(construction.callee, state, "Array") &&
  semanticPrimitiveArguments(construction.arguments, state) &&
  // Include argument evaluation and inherited numeric accessors through holes.
  !["Array", "Object"].some((owner) =>
    semanticAmbientObjectMayHaveChangedAt(
      invocation,
      state,
      ["global", owner, "prototype"],
      invocation,
    ),
  ) &&
  !semanticOpaqueGlobalMayHaveChanged(invocation, state);

/** Empty native Maps have no iterable hooks or retained entry objects. */
export const semanticPristineEmptyMapConstruction = (
  construction: t.NewExpression,
  invocation: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  isUnmodifiedGlobalReference(construction.callee, state, "Map") &&
  construction.arguments.length === 0 &&
  !["Map", "Object"].some((owner) =>
    semanticAmbientObjectMayHaveChangedAt(
      invocation,
      state,
      ["global", owner, "prototype"],
      invocation,
    ),
  ) &&
  !semanticOpaqueGlobalMayHaveChanged(invocation, state);
