import * as t from "@babel/types";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticPromiseOperation,
} from "./javascriptSemanticIr.js";
import {
  semanticCallableIdForNode,
  semanticStaticPropertyName,
} from "./javascriptSemanticProjection.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import {
  compareCodePoints,
  range,
  sourceRangesEqual,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  assignedSemanticResultBindings,
  containsSemanticNode,
  dataEffectMemberCallee,
  scalarAssignedResultBinding,
} from "./javascriptSemanticDataEffectHelpers.js";

type PromiseMethod = JavaScriptSemanticPromiseOperation["method"];
type PromiseKind = JavaScriptSemanticPromiseOperation["kind"];

interface PromiseCandidate {
  readonly node: t.Node;
  readonly kind: PromiseKind;
  readonly method: PromiseMethod;
  readonly promiseId: string;
  readonly ownerCallableId: string | null;
  readonly ancestors: readonly t.Node[];
}

interface PromiseResolution {
  readonly promiseIds: readonly string[];
  readonly status: JavaScriptSemanticPromiseOperation["sourceResolution"];
}

interface PromiseOwnership {
  readonly ownership: JavaScriptSemanticPromiseOperation["ownership"];
  readonly ownerBindingId: string | null;
  readonly returnSiteId: string | null;
}

interface PromiseExpressionResolutionContext {
  readonly current: PromiseCandidate;
  readonly candidateByNode: WeakMap<t.Node, PromiseCandidate>;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly seenBindings: ReadonlySet<string>;
}

interface PromiseOwnershipContext {
  readonly candidate: PromiseCandidate;
  readonly candidateByNode: WeakMap<t.Node, PromiseCandidate>;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callables: readonly JavaScriptSemanticCallable[];
}

/** Recover explicit Promise construction, chaining, aggregation, and ownership. */
export const collectJavaScriptSemanticPromises = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): JavaScriptSemanticPromiseOperation[] => {
  const candidates = collectCandidates(program, state, callables);
  const candidateByNode = new WeakMap<t.Node, PromiseCandidate>();
  for (const candidate of candidates)
    candidateByNode.set(candidate.node, candidate);
  return candidates.map((candidate) => {
    const ownership = promiseOwnership(
      candidate,
      candidateByNode,
      state,
      callables,
    );
    const sources = promiseSources(candidate, candidateByNode, state);
    return {
      promiseId: candidate.promiseId,
      kind: candidate.kind,
      method: candidate.method,
      location: range(candidate.node),
      ownerCallableId: candidate.ownerCallableId,
      ...ownership,
      sourcePromiseIds: [...new Set(sources.promiseIds)].sort(
        compareCodePoints,
      ),
      sourceResolution: sources.status,
    };
  });
};

const collectCandidates = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): PromiseCandidate[] => {
  const output: PromiseCandidate[] = [];
  const admittedCallables = new Set(
    callables.map(({ callableId }) => callableId),
  );
  const callableStack: string[] = [];
  const ancestors: t.Node[] = [];
  traverseJavaScriptAst(program, {
    enter: (node) => {
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && admittedCallables.has(callableId))
        callableStack.push(callableId);
      const details = promiseCandidateDetails(node, state);
      if (details !== null) {
        output.push({
          node,
          ...details,
          promiseId: semanticPromiseId(details.kind, node),
          ownerCallableId: callableStack.at(-1) ?? null,
          ancestors: [...ancestors],
        });
      }
      ancestors.push(node);
    },
    exit: (node) => {
      ancestors.pop();
      const callableId = semanticCallableIdForNode(node);
      if (callableId !== null && callableStack.at(-1) === callableId)
        callableStack.pop();
    },
  });
  return output;
};

const promiseCandidateDetails = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): Pick<PromiseCandidate, "kind" | "method"> | null => {
  if (
    t.isNewExpression(node) &&
    t.isIdentifier(node.callee, { name: "Promise" }) &&
    isUnshadowedGlobalPromise(node.callee, state)
  )
    return { kind: "constructor", method: "new" };
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
    const member = dataEffectMemberCallee(node);
    if (member === null) return null;
    const method = semanticStaticPropertyName(member.property, member.computed);
    if (
      t.isIdentifier(member.object, { name: "Promise" }) &&
      isUnshadowedGlobalPromise(member.object, state)
    ) {
      if (method === "all" || method === "allSettled")
        return { kind: "aggregate", method };
      if (method === "resolve" || method === "reject")
        return { kind: "static", method };
    }
    if (method === "then" || method === "catch" || method === "finally")
      return { kind: "chain", method };
  }
  if (t.isAwaitExpression(node) && !isPromiseProducer(node.argument, state))
    return { kind: "awaited-expression", method: "await" };
  return null;
};

const isUnshadowedGlobalPromise = (
  node: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  resolveSemanticBindingState(state, node, "Promise") === undefined &&
  !semanticResolutionBlocked(state, node, "Promise");

const isPromiseProducer = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => promiseCandidateDetails(unwrapExpression(node), state) !== null;

const semanticPromiseId = (kind: PromiseKind, node: t.Node): string =>
  `promise:${kind}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`;

const promiseOwnership = (
  candidate: PromiseCandidate,
  candidateByNode: WeakMap<t.Node, PromiseCandidate>,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): PromiseOwnership => {
  if (candidate.kind === "awaited-expression") return emptyOwnership("awaited");
  const context: PromiseOwnershipContext = {
    candidate,
    candidateByNode,
    state,
    callables,
  };
  for (let index = candidate.ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = candidate.ancestors[index];
    if (ancestor === undefined) continue;
    const ownership = ownershipAtAncestor(ancestor, context);
    if (ownership === "boundary") break;
    if (ownership !== null) return ownership;
  }
  return emptyOwnership("unknown");
};

const ownershipAtAncestor = (
  ancestor: t.Node,
  context: PromiseOwnershipContext,
): PromiseOwnership | "boundary" | null => {
  const { candidate, candidateByNode, state, callables } = context;
  if (t.isAwaitExpression(ancestor)) return emptyOwnership("awaited");
  const outer = candidateByNode.get(ancestor);
  if (
    outer !== undefined &&
    outer.ownerCallableId === candidate.ownerCallableId &&
    outerConsumesCandidate(outer, candidate)
  )
    return outer.kind === "chain"
      ? emptyOwnership("chained")
      : emptyOwnership("aggregated");
  const assigned = assignedPromiseBinding(ancestor, state);
  if (assigned !== undefined)
    return {
      ownership: "assigned",
      ownerBindingId: assigned,
      returnSiteId: null,
    };
  if (t.isReturnStatement(ancestor))
    return returnedPromiseOwnership(
      candidate.ownerCallableId,
      range(ancestor),
      callables,
    );
  if (t.isExpressionStatement(ancestor)) return emptyOwnership("detached");
  const callableId = semanticCallableIdForNode(ancestor);
  if (callableId === null || callableId !== candidate.ownerCallableId)
    return null;
  return t.isArrowFunctionExpression(ancestor) &&
    ancestor.body === candidate.node
    ? returnedPromiseOwnership(
        candidate.ownerCallableId,
        range(candidate.node),
        callables,
      )
    : "boundary";
};

const assignedPromiseBinding = (
  ancestor: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | null | undefined => {
  if (!t.isVariableDeclarator(ancestor) && !t.isAssignmentExpression(ancestor))
    return undefined;
  const source = t.isVariableDeclarator(ancestor)
    ? ancestor.init
    : ancestor.right;
  if (source == null) return undefined;
  return scalarAssignedResultBinding(
    assignedSemanticResultBindings(source, [ancestor], state),
  );
};

const returnedPromiseOwnership = (
  callableId: string | null,
  location: JavaScriptSemanticPromiseOperation["location"],
  callables: readonly JavaScriptSemanticCallable[],
): PromiseOwnership => ({
  ownership: "returned",
  ownerBindingId: null,
  returnSiteId: matchingReturnSite(callableId, location, callables),
});

const outerConsumesCandidate = (
  outer: PromiseCandidate,
  candidate: PromiseCandidate,
): boolean => {
  if (
    outer.kind === "chain" &&
    (t.isCallExpression(outer.node) || t.isOptionalCallExpression(outer.node))
  ) {
    const member = dataEffectMemberCallee(outer.node);
    return (
      member !== null && containsSemanticNode(member.object, candidate.node)
    );
  }
  if (
    outer.kind === "aggregate" &&
    (t.isCallExpression(outer.node) || t.isOptionalCallExpression(outer.node))
  ) {
    const input = outer.node.arguments[0];
    return t.isNode(input) && containsSemanticNode(input, candidate.node);
  }
  return false;
};

const emptyOwnership = (
  ownership: JavaScriptSemanticPromiseOperation["ownership"],
): PromiseOwnership => ({
  ownership,
  ownerBindingId: null,
  returnSiteId: null,
});

const matchingReturnSite = (
  callableId: string | null,
  location: JavaScriptSemanticPromiseOperation["location"],
  callables: readonly JavaScriptSemanticCallable[],
): string | null =>
  callables
    .find(({ callableId: candidate }) => candidate === callableId)
    ?.returnSites.find(({ location: candidate }) =>
      sourceRangesEqual(candidate, location),
    )?.returnSiteId ?? null;

const promiseSources = (
  candidate: PromiseCandidate,
  candidateByNode: WeakMap<t.Node, PromiseCandidate>,
  state: JavaScriptSemanticAnalysisState,
): PromiseResolution => {
  if (candidate.kind === "chain") {
    const member =
      t.isCallExpression(candidate.node) ||
      t.isOptionalCallExpression(candidate.node)
        ? dataEffectMemberCallee(candidate.node)
        : null;
    return member === null
      ? unresolvedPromise()
      : resolvePromiseExpression(
          member.object,
          promiseResolutionContext(candidate, candidateByNode, state),
        );
  }
  if (candidate.kind === "aggregate")
    return aggregateSources(candidate, candidateByNode, state);
  if (candidate.kind === "awaited-expression")
    return t.isAwaitExpression(candidate.node)
      ? resolvePromiseExpression(
          candidate.node.argument,
          promiseResolutionContext(candidate, candidateByNode, state),
        )
      : unresolvedPromise();
  return { promiseIds: [], status: "complete" };
};

const aggregateSources = (
  candidate: PromiseCandidate,
  candidateByNode: WeakMap<t.Node, PromiseCandidate>,
  state: JavaScriptSemanticAnalysisState,
): PromiseResolution => {
  if (
    !t.isCallExpression(candidate.node) &&
    !t.isOptionalCallExpression(candidate.node)
  )
    return unresolvedPromise();
  const input = candidate.node.arguments[0];
  if (!t.isArrayExpression(input)) return unresolvedPromise();
  const resolutions = input.elements.map((element) => {
    if (element === null) return completePromise();
    if (t.isSpreadElement(element)) return unresolvedPromise();
    if (isObviouslyNonPromise(element)) return completePromise();
    return resolvePromiseExpression(
      element,
      promiseResolutionContext(candidate, candidateByNode, state),
    );
  });
  return combinePromiseResolutions(resolutions);
};

const resolvePromiseExpression = (
  rawNode: t.Node,
  context: PromiseExpressionResolutionContext,
): PromiseResolution => {
  const { current, candidateByNode, state, seenBindings } = context;
  const node = unwrapExpression(rawNode);
  const direct = candidateByNode.get(node);
  if (direct !== undefined && direct.promiseId !== current.promiseId)
    return { promiseIds: [direct.promiseId], status: "complete" };
  if (!t.isIdentifier(node)) return unresolvedPromise();
  const binding = resolveSemanticBindingState(state, node, node.name);
  if (
    binding === undefined ||
    binding.mutable ||
    binding.initializers.length !== 1 ||
    seenBindings.has(binding.bindingId)
  )
    return unresolvedPromise();
  const initializer = binding.initializers[0];
  if (initializer === undefined || initializer.projection.length > 0)
    return unresolvedPromise();
  const nestedSeen = new Set(seenBindings);
  nestedSeen.add(binding.bindingId);
  return resolvePromiseExpression(initializer.node, {
    ...context,
    seenBindings: nestedSeen,
  });
};

const promiseResolutionContext = (
  current: PromiseCandidate,
  candidateByNode: WeakMap<t.Node, PromiseCandidate>,
  state: JavaScriptSemanticAnalysisState,
): PromiseExpressionResolutionContext => ({
  current,
  candidateByNode,
  state,
  seenBindings: new Set(),
});

const unwrapExpression = (node: t.Node): t.Node => {
  if (
    t.isParenthesizedExpression(node) ||
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node) ||
    t.isTypeCastExpression(node)
  )
    return unwrapExpression(node.expression);
  return node;
};

const combinePromiseResolutions = (
  resolutions: readonly PromiseResolution[],
): PromiseResolution => ({
  promiseIds: resolutions.flatMap(({ promiseIds }) => promiseIds),
  status: resolutions.some(({ status }) => status === "unresolved")
    ? resolutions.some(({ status }) => status === "complete")
      ? "partial"
      : "unresolved"
    : resolutions.some(({ status }) => status === "partial")
      ? "partial"
      : "complete",
});

const completePromise = (): PromiseResolution => ({
  promiseIds: [],
  status: "complete",
});

const unresolvedPromise = (): PromiseResolution => ({
  promiseIds: [],
  status: "unresolved",
});

const isObviouslyNonPromise = (node: t.Node): boolean =>
  t.isLiteral(node) ||
  t.isObjectExpression(node) ||
  t.isFunction(node) ||
  t.isClassExpression(node);
