import * as t from "@babel/types";

import type {
  JavaScriptSemanticArgumentFlow,
  JavaScriptSemanticCallable,
  JavaScriptSemanticCallReturnFlow,
  JavaScriptSemanticCallSite,
  JavaScriptSemanticClosureCapture,
  JavaScriptSemanticFrontier,
} from "./javascriptSemanticIr.js";
import {
  reachSemanticLimit,
  semanticCallableIdForNode,
  semanticReferenceRole,
  semanticStaticPropertyName,
} from "./javascriptSemanticProjection.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  type LocalCallableResolution,
  parameterBindings,
  resolveLocalCallables,
} from "./javascriptSemanticCallResolution.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";

/** Local call, flow, capture, and unsupported-frontier facts. */
export interface JavaScriptSemanticCallAnalysis {
  readonly callSites: readonly JavaScriptSemanticCallSite[];
  readonly argumentFlows: readonly JavaScriptSemanticArgumentFlow[];
  readonly callReturnFlows: readonly JavaScriptSemanticCallReturnFlow[];
  readonly closureCaptures: readonly JavaScriptSemanticClosureCapture[];
  readonly frontiers: readonly JavaScriptSemanticFrontier[];
}

interface MutableCallAnalysis {
  readonly callSites: JavaScriptSemanticCallSite[];
  readonly argumentFlows: JavaScriptSemanticArgumentFlow[];
  readonly callReturnFlows: JavaScriptSemanticCallReturnFlow[];
  readonly closureCaptures: JavaScriptSemanticClosureCapture[];
  readonly frontiers: JavaScriptSemanticFrontier[];
  retainedArguments: number;
}

interface CallCollectionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableById: ReadonlyMap<string, JavaScriptSemanticCallable>;
  readonly output: MutableCallAnalysis;
  readonly bindingResolutionCache: Map<string, LocalCallableResolution>;
  readonly parameterBindingCache: Map<
    string,
    readonly JavaScriptSemanticBindingState[]
  >;
}

/** Recover bounded direct-call and lexical-capture candidates from inert syntax. */
export const collectJavaScriptSemanticCalls = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): JavaScriptSemanticCallAnalysis => {
  const output: MutableCallAnalysis = {
    callSites: [],
    argumentFlows: [],
    callReturnFlows: [],
    closureCaptures: [],
    frontiers: [],
    retainedArguments: 0,
  };
  const callableById = new Map(
    callables.map((callable) => [callable.callableId, callable]),
  );
  const context: CallCollectionContext = {
    state,
    callableById,
    output,
    bindingResolutionCache: new Map(),
    parameterBindingCache: new Map(),
  };
  const callableStack: JavaScriptSemanticCallable[] = [];
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      const callableId = semanticCallableIdForNode(node);
      const callable =
        callableId === null ? undefined : callableById.get(callableId);
      if (callable !== undefined) callableStack.push(callable);
      const owner = enclosingFunction(callableStack);
      collectCapture(node, parent, owner, context);
      collectDynamicProperty(node, owner, state, output);
      if (
        t.isCallExpression(node) ||
        t.isOptionalCallExpression(node) ||
        t.isNewExpression(node)
      )
        collectCallSite(node, owner, context);
    },
    exit: (node) => {
      const callableId = semanticCallableIdForNode(node);
      if (
        callableId !== null &&
        callableStack.at(-1)?.callableId === callableId
      )
        callableStack.pop();
    },
  });
  return {
    callSites: output.callSites,
    argumentFlows: output.argumentFlows,
    callReturnFlows: output.callReturnFlows,
    closureCaptures: output.closureCaptures,
    frontiers: output.frontiers,
  };
};

const collectCallSite = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  owner: JavaScriptSemanticCallable | undefined,
  context: CallCollectionContext,
): void => {
  const { state, callableById, output } = context;
  if (output.callSites.length >= state.limits.maxCallSites) {
    reachSemanticLimit(state, "maxCallSites");
    return;
  }
  const resolution = resolveLocalCallables({
    node: node.callee,
    state,
    callableById,
    seenBindings: new Set(),
    depth: 0,
    bindingCache: context.bindingResolutionCache,
  });
  const callSiteId = semanticCallSiteId(node);
  const argumentsValue = retainedArguments(node.arguments, state, output);
  const site: JavaScriptSemanticCallSite = {
    callSiteId,
    kind: t.isNewExpression(node) ? "construct" : "call",
    callerCallableId: owner?.callableId ?? null,
    location: range(node),
    calleeLocation: range(node.callee),
    resolution:
      resolution.callableIds.length === 1 && resolution.complete
        ? "exact"
        : resolution.callableIds.length > 0
          ? "ambiguous"
          : "unresolved",
    calleeCallableIds: resolution.callableIds,
    arguments: argumentsValue,
  };
  output.callSites.push(site);
  if (site.resolution !== "exact")
    addFrontier(
      {
        kind: "dynamic-call",
        callableId: owner?.callableId ?? null,
        location: range(node.callee),
        reason: resolution.reason,
      },
      state,
      output,
    );
  collectArgumentFlows(site, node, context);
  if (site.kind === "call")
    collectReturnFlows(site, callableById, state, output);
};

const retainedArguments = (
  nodes: readonly (
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
  )[],
  state: JavaScriptSemanticAnalysisState,
  output: MutableCallAnalysis,
): JavaScriptSemanticCallSite["arguments"] => {
  const retained: JavaScriptSemanticCallSite["arguments"][number][] = [];
  for (const [index, node] of nodes.entries()) {
    if (output.retainedArguments >= state.limits.maxCallArguments) {
      reachSemanticLimit(state, "maxCallArguments");
      break;
    }
    output.retainedArguments += 1;
    retained.push({
      index,
      location: range(node),
      spread: t.isSpreadElement(node),
    });
  }
  return retained;
};

const collectArgumentFlows = (
  site: JavaScriptSemanticCallSite,
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
  context: CallCollectionContext,
): void => {
  const { state, callableById, output } = context;
  const retainedIndexes = new Set(site.arguments.map(({ index }) => index));
  let positionIsExact = true;
  for (const [index, argument] of node.arguments.entries()) {
    if (t.isSpreadElement(argument)) {
      positionIsExact = false;
      continue;
    }
    if (
      !positionIsExact ||
      !retainedIndexes.has(index) ||
      !t.isExpression(argument)
    )
      continue;
    for (const callableId of site.calleeCallableIds) {
      const callable = callableById.get(callableId);
      if (callable === undefined) continue;
      for (const parameter of cachedParameterBindings(
        callable,
        index,
        context,
      )) {
        if (output.argumentFlows.length >= state.limits.maxArgumentFlows) {
          reachSemanticLimit(state, "maxArgumentFlows");
          return;
        }
        const definition = parameter.definitions.find(
          ({ kind }) => kind === "parameter",
        );
        if (definition === undefined) continue;
        output.argumentFlows.push({
          callSiteId: site.callSiteId,
          argumentIndex: index,
          argumentLocation: range(argument),
          callableId,
          parameterBindingId: parameter.bindingId,
          parameterLocation: definition.location,
        });
      }
    }
  }
};

const cachedParameterBindings = (
  callable: JavaScriptSemanticCallable,
  index: number,
  context: CallCollectionContext,
): readonly JavaScriptSemanticBindingState[] => {
  const key = `${callable.callableId}:${String(index)}`;
  const cached = context.parameterBindingCache.get(key);
  if (cached !== undefined) return cached;
  const bindings = parameterBindings(callable, index, context.state);
  context.parameterBindingCache.set(key, bindings);
  return bindings;
};

const collectReturnFlows = (
  site: JavaScriptSemanticCallSite,
  callableById: ReadonlyMap<string, JavaScriptSemanticCallable>,
  state: JavaScriptSemanticAnalysisState,
  output: MutableCallAnalysis,
): void => {
  for (const callableId of site.calleeCallableIds) {
    const callable = callableById.get(callableId);
    if (callable === undefined) continue;
    for (const returnSite of callable.returnSites) {
      if (output.callReturnFlows.length >= state.limits.maxCallReturnFlows) {
        reachSemanticLimit(state, "maxCallReturnFlows");
        return;
      }
      output.callReturnFlows.push({
        callSiteId: site.callSiteId,
        callableId,
        returnSiteId: returnSite.returnSiteId,
        returnLocation: returnSite.location,
      });
    }
  }
};

const collectCapture = (
  node: t.Node,
  parent: t.Node | null,
  owner: JavaScriptSemanticCallable | undefined,
  context: CallCollectionContext,
): void => {
  const { state, output } = context;
  if (
    !t.isIdentifier(node) ||
    parent === null ||
    owner === undefined ||
    owner.bodyScopeId === null
  )
    return;
  if (semanticReferenceRole(node, parent) === null) return;
  const binding = resolveSemanticBindingState(state, node, node.name);
  if (
    binding === undefined ||
    bindingIsWithinCallable(binding, owner.bodyScopeId, state)
  )
    return;
  if (output.closureCaptures.length >= state.limits.maxClosureCaptures) {
    reachSemanticLimit(state, "maxClosureCaptures");
    return;
  }
  output.closureCaptures.push({
    callableId: owner.callableId,
    bindingId: binding.bindingId,
    referenceLocation: range(node),
  });
};

const collectDynamicProperty = (
  node: t.Node,
  owner: JavaScriptSemanticCallable | undefined,
  state: JavaScriptSemanticAnalysisState,
  output: MutableCallAnalysis,
): void => {
  if (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    semanticStaticPropertyName(node.property, node.computed) === ""
  )
    addFrontier(
      {
        kind: "dynamic-property",
        callableId: owner?.callableId ?? null,
        location: range(node.property),
        reason: "Computed member property is not a static string or number.",
      },
      state,
      output,
    );
  else if (
    (t.isObjectProperty(node) || t.isObjectMethod(node)) &&
    node.computed &&
    semanticStaticPropertyName(node.key, true) === ""
  )
    addFrontier(
      {
        kind: "dynamic-property",
        callableId: owner?.callableId ?? null,
        location: range(node.key),
        reason: "Computed object property is not a static string or number.",
      },
      state,
      output,
    );
};

const addFrontier = (
  frontier: JavaScriptSemanticFrontier,
  state: JavaScriptSemanticAnalysisState,
  output: MutableCallAnalysis,
): void => {
  if (output.frontiers.length >= state.limits.maxFrontiers) {
    reachSemanticLimit(state, "maxFrontiers");
    return;
  }
  output.frontiers.push(frontier);
};

const bindingIsWithinCallable = (
  binding: JavaScriptSemanticBindingState,
  bodyScopeId: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let scope = state.scopesById.get(binding.scopeId);
  while (scope !== undefined) {
    if (scope.scopeId === bodyScopeId) return true;
    scope =
      scope.parentScopeId === null
        ? undefined
        : state.scopesById.get(scope.parentScopeId);
  }
  return false;
};

const enclosingFunction = (
  stack: readonly JavaScriptSemanticCallable[],
): JavaScriptSemanticCallable | undefined =>
  stack.findLast(({ kind }) => kind !== "class");

const semanticCallSiteId = (
  node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
): string =>
  `call:${t.isNewExpression(node) ? "construct" : "call"}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`;
