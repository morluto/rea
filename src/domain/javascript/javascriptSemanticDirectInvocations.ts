/**
 * Arguments of a directly invoked source function expression. The callee's
 * body is source code whose effects are indexed like any other, so an
 * argument it can reach only through a plain parameter does not escape at
 * the call: effect owners follow the parameter to the argument instead.
 */
import * as t from "@babel/types";

import {
  runtimeFunctionParameters,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticDirectEvalRecorded } from "./javascriptSemanticEffectRecord.js";
import { childNodes } from "./javascriptSemanticTraversal.js";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

/**
 * A call that directly invokes a source function expression, as in a UMD
 * header `(function (root, factory) { ... })(this, ...)`. `bound[i]` is the
 * parameter that argument `i` binds, `null` when nothing in the body can
 * reach it, and `undefined` when the body may reach it other than through a
 * plain parameter (a spread or rest list, `arguments` or direct `eval`).
 */
interface DirectInvocation {
  readonly call: t.CallExpression;
  readonly bound: readonly (t.Identifier | null | undefined)[];
}

const directInvocations = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Function, DirectInvocation | null>
>();

/** Whether `node` reads its activation's arguments other than by parameters. */
const readsArgumentsObject = (node: t.Node): boolean => {
  const pending: t.Node[] = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (t.isIdentifier(current, { name: "arguments" })) return true;
    for (const child of childNodes(current)) pending.push(child);
  }
  return false;
};

/** The call that invokes function expression `callee` where it is defined. */
const directCall = (
  callee: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): t.CallExpression | undefined => {
  if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee))
    return undefined;
  let call = parents.get(callee);
  while (call !== undefined && unwrapJavaScriptExpression(call).node === callee)
    call = parents.get(call);
  return t.isCallExpression(call) &&
    unwrapJavaScriptExpression(call.callee).node === callee
    ? call
    : undefined;
};

const computeDirectInvocation = (
  callee: t.Function,
  state: JavaScriptSemanticAnalysisState,
): DirectInvocation | undefined => {
  const call = directCall(callee, state.parentsByNode);
  if (call === undefined) return undefined;
  if (call.arguments.length === 0) return { call, bound: [] };
  // Only plain parameter lists bind every argument by position alone and
  // share one scope with the body.
  const parameters = runtimeFunctionParameters(callee);
  const rest = parameters.findIndex((parameter) => t.isRestElement(parameter));
  if (
    parameters.some(
      (parameter, index) => !t.isIdentifier(parameter) && index !== rest,
    ) ||
    semanticDirectEvalRecorded(state) ||
    readsArgumentsObject(callee)
  )
    return undefined;
  const spread = call.arguments.findIndex((argument) =>
    t.isSpreadElement(argument),
  );
  const bound = call.arguments.map((_, index) => {
    if ((spread >= 0 && index >= spread) || (rest >= 0 && index >= rest))
      return undefined;
    const parameter = parameters[index];
    if (!t.isIdentifier(parameter)) return null;
    // A later duplicate parameter name shadows this one.
    return parameters
      .slice(index + 1)
      .some((later) => t.isIdentifier(later, { name: parameter.name }))
      ? null
      : parameter;
  });
  return { call, bound };
};

const directInvocation = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): DirectInvocation | undefined => {
  if (!t.isFunction(callee)) return undefined;
  let byCallee = directInvocations.get(state);
  if (byCallee === undefined) {
    byCallee = new WeakMap();
    directInvocations.set(state, byCallee);
  }
  let cached = byCallee.get(callee);
  if (cached === undefined) {
    cached = computeDirectInvocation(callee, state) ?? null;
    byCallee.set(callee, cached);
  }
  return cached ?? undefined;
};

/**
 * Whether argument `index` of `call` reaches the callee only through a
 * parameter whose effects are followed to the argument, so passing it is not
 * an escape to code whose effects are not evaluated.
 */
export const semanticArgumentStaysInSource = (
  call: t.Node,
  index: number,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!t.isCallExpression(call)) return false;
  const invocation = directInvocation(
    unwrapJavaScriptExpression(call.callee).node,
    state,
  );
  return invocation?.call === call && invocation.bound[index] !== undefined;
};

const parameterArguments = new WeakMap<
  JavaScriptSemanticBindingState,
  t.Expression | null
>();

/**
 * The argument a directly invoked function's parameter `binding` receives;
 * `reference` is any reference to the binding inside that function. A body
 * declaration of the parameter's name shares its binding, so the argument
 * stays among that binding's values.
 */
export const semanticDirectInvocationArgument = (
  reference: t.Node,
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): t.Expression | undefined => {
  const cached = parameterArguments.get(binding);
  if (cached !== undefined) return cached ?? undefined;
  let argument: t.Expression | undefined;
  if (state.scopesById.get(binding.scopeId)?.kind === "function")
    for (
      let current = state.parentsByNode.get(reference);
      current !== undefined;
      current = state.parentsByNode.get(current)
    ) {
      if (
        !t.isFunction(current) ||
        state.scopeByNode.get(current)?.scopeId !== binding.scopeId
      )
        continue;
      const invocation = directInvocation(current, state);
      const index =
        invocation?.bound.findIndex(
          (parameter) => parameter?.name === binding.name,
        ) ?? -1;
      const selected = invocation?.call.arguments[index];
      if (index >= 0 && t.isExpression(selected)) argument = selected;
      break;
    }
  parameterArguments.set(binding, argument ?? null);
  return argument;
};
