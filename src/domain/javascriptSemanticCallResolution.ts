import * as t from "@babel/types";

import type {
  JavaScriptSemanticArgumentFlow,
  JavaScriptSemanticCallable,
} from "./javascriptSemanticIr.js";
import {
  reachSemanticLimit,
  semanticCallableIdForNode,
} from "./javascriptSemanticProjection.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { compareCodePoints, range } from "./javascriptStaticAnalysisHelpers.js";

/** Resolution of one call target within the currently analyzed source. */
export interface LocalCallableResolution {
  readonly callableIds: readonly string[];
  readonly complete: boolean;
  readonly reason: string;
}

interface CallResolutionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableById: ReadonlyMap<string, JavaScriptSemanticCallable>;
  readonly seenBindings: ReadonlySet<string>;
  readonly depth: number;
  readonly bindingCache: Map<string, LocalCallableResolution>;
}

/** Inputs needed to resolve one local call target. */
export interface ResolveLocalCallablesInput {
  readonly node: t.Node;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableById: ReadonlyMap<string, JavaScriptSemanticCallable>;
  readonly seenBindings: ReadonlySet<string>;
  readonly depth: number;
  readonly bindingCache: Map<string, LocalCallableResolution>;
}

/** Resolve bounded local callable candidates without following dynamic properties. */
export const resolveLocalCallables = (
  input: ResolveLocalCallablesInput,
): LocalCallableResolution =>
  resolveCallables(input.node, {
    state: input.state,
    callableById: input.callableById,
    seenBindings: input.seenBindings,
    depth: input.depth,
    bindingCache: input.bindingCache,
  });

const resolveCallables = (
  node: t.Node,
  context: CallResolutionContext,
): LocalCallableResolution => {
  if (context.depth >= context.state.limits.maxValueDepth) {
    reachSemanticLimit(context.state, "maxValueDepth");
    return {
      callableIds: [],
      complete: false,
      reason: "Call target depth limit reached.",
    };
  }
  const direct = semanticCallableIdForNode(node);
  if (direct !== null && context.callableById.has(direct))
    return {
      callableIds: [direct],
      complete: true,
      reason: "Direct local callable.",
    };
  if (t.isIdentifier(node)) return resolveIdentifier(node, context);
  if (
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSNonNullExpression(node)
  )
    return resolveCallables(node.expression, nestedContext(context));
  if (t.isConditionalExpression(node) || t.isLogicalExpression(node))
    return resolveAlternatives(
      t.isConditionalExpression(node) ? node.consequent : node.left,
      t.isConditionalExpression(node) ? node.alternate : node.right,
      context,
    );
  return {
    callableIds: [],
    complete: false,
    reason: `Unsupported ${node.type} call target.`,
  };
};

const resolveIdentifier = (
  node: t.Identifier,
  context: CallResolutionContext,
): LocalCallableResolution => {
  const binding = resolveSemanticBindingState(context.state, node, node.name);
  return binding === undefined
    ? {
        callableIds: [],
        complete: false,
        reason: `Unresolved call target ${node.name}.`,
      }
    : resolveBindingCallables(binding, nestedContext(context));
};

const resolveAlternatives = (
  left: t.Node,
  right: t.Node,
  context: CallResolutionContext,
): LocalCallableResolution => {
  const candidates = [left, right].map((candidate) =>
    resolveCallables(candidate, nestedContext(context)),
  );
  return {
    callableIds: uniqueCallableIds(
      candidates.flatMap(({ callableIds }) => callableIds),
    ),
    complete: candidates.every(({ complete }) => complete),
    reason: "Conditional or logical call target has multiple candidates.",
  };
};

const resolveBindingCallables = (
  binding: JavaScriptSemanticBindingState,
  context: CallResolutionContext,
): LocalCallableResolution => {
  const cached = context.bindingCache.get(binding.bindingId);
  if (cached !== undefined) return cached;
  if (context.seenBindings.has(binding.bindingId))
    return {
      callableIds: [],
      complete: false,
      reason: `Call target alias cycle at ${binding.name}.`,
    };
  if (binding.initializers.length === 0)
    return missingBindingInitializer(binding);
  const candidateContext = {
    ...nestedContext(context),
    seenBindings: new Set([...context.seenBindings, binding.bindingId]),
  };
  const candidates = binding.initializers.map(({ node, projection }) =>
    projection.length === 0
      ? resolveCallables(node, candidateContext)
      : {
          callableIds: [],
          complete: false,
          reason: `Projected call target ${binding.name} is unresolved.`,
        },
  );
  const callableIds = uniqueCallableIds(
    candidates.flatMap((candidate) => candidate.callableIds),
  );
  const resolution = {
    callableIds,
    complete: candidates.every(({ complete }) => complete),
    reason:
      callableIds.length === 1 && candidates.every(({ complete }) => complete)
        ? "Unique local callable target."
        : `Call target ${binding.name} has ambiguous or unsupported assignments.`,
  };
  if (resolution.complete)
    context.bindingCache.set(binding.bindingId, resolution);
  return resolution;
};

const missingBindingInitializer = (
  binding: JavaScriptSemanticBindingState,
): LocalCallableResolution => ({
  callableIds: [],
  complete: false,
  reason:
    binding.kind === "import"
      ? `Call target ${binding.name} is imported from outside this source.`
      : `Call target ${binding.name} has no local initializer.`,
});

/** Find all bindings introduced by one positional parameter pattern. */
export const parameterBindings = (
  callable: JavaScriptSemanticCallable,
  index: number,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState[] => {
  if (callable.bodyScopeId === null) return [];
  const scope = state.scopesById.get(callable.bodyScopeId);
  if (scope === undefined) return [];
  return [...scope.bindings.values()]
    .filter(
      (binding) =>
        binding.kind === "parameter" &&
        binding.definitions.some(
          ({ kind, location }) =>
            kind === "parameter" &&
            parameterIndex(callable, location, state) === index,
        ),
    )
    .sort((left, right) => compareCodePoints(left.bindingId, right.bindingId));
};

const parameterIndex = (
  callable: JavaScriptSemanticCallable,
  location: JavaScriptSemanticArgumentFlow["parameterLocation"],
  state: JavaScriptSemanticAnalysisState,
): number => {
  const node = state.callableNodesById.get(callable.callableId);
  if (!t.isFunction(node)) return -1;
  return node.params.findIndex((parameter) =>
    rangeContains(range(parameter), location),
  );
};

const rangeContains = (
  outer: JavaScriptSemanticArgumentFlow["parameterLocation"],
  inner: JavaScriptSemanticArgumentFlow["parameterLocation"],
): boolean =>
  (outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line &&
      outer.start.column <= inner.start.column)) &&
  (outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line &&
      outer.end.column >= inner.end.column));

const nestedContext = (
  context: CallResolutionContext,
): CallResolutionContext => ({ ...context, depth: context.depth + 1 });

const uniqueCallableIds = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodePoints);
