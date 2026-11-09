import * as t from "@babel/types";

import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
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
