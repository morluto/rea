import { javascriptSourceRangeContains } from "./javascriptSourceCoordinates.js";
import * as t from "@babel/types";

import type {
  JavaScriptSemanticArgumentFlow,
  JavaScriptSemanticCallable,
} from "./javascriptSemanticIr.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { semanticCallableIdForNode } from "./javascriptSemanticProjection.js";
import {
  semanticBindingAtRead,
  semanticEffectTiming,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
  runtimeFunctionParameters,
} from "./javascriptAstValues.js";
import {
  MAX_CLASS_CANDIDATES,
  fieldProofIsSingle,
  getClassRegistry,
  lookupSuperMethod,
  lookupUnitOneMethod,
  proveGetterReceiver,
  proveUnitTwoReceiver,
} from "./javascriptSemanticClassReceivers.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";

/** Resolution of one call target within the currently analyzed source. */
export interface LocalCallableResolution {
  readonly callableIds: readonly string[];
  readonly complete: boolean;
  readonly reason: string;
  /** A cycle cut depends on the active alias path and cannot be memoized. */
  readonly cycleDependent?: true;
}

interface CallResolutionContext {
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableById: ReadonlyMap<string, JavaScriptSemanticCallable>;
  readonly seenInitializers: ReadonlySet<JavaScriptSemanticInitializer>;
  /** Bindings on the active chain whose read selected every initializer. */
  readonly seenBindings: ReadonlySet<JavaScriptSemanticBindingState>;
  readonly bindingCache: WeakMap<t.Identifier, LocalCallableResolution>;
}

/** Inputs needed to resolve one local call target. */
export interface ResolveLocalCallablesInput {
  readonly node: t.Node;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly callableById: ReadonlyMap<string, JavaScriptSemanticCallable>;
  readonly seenInitializers: ReadonlySet<JavaScriptSemanticInitializer>;
  readonly bindingCache: WeakMap<t.Identifier, LocalCallableResolution>;
}

/** Resolve local callable candidates without following dynamic properties. */
export const resolveLocalCallables = (
  input: ResolveLocalCallablesInput,
): LocalCallableResolution =>
  resolveCallables(input.node, {
    state: input.state,
    callableById: input.callableById,
    seenInitializers: input.seenInitializers,
    seenBindings: new Set(),
    bindingCache: input.bindingCache,
  });

const resolveCallables = (
  node: t.Node,
  context: CallResolutionContext,
): LocalCallableResolution => {
  // `unwrapJavaScriptExpression` strips all transparent layers iteratively,
  // so a single recursion step suffices (no per-layer stack growth).
  const unwrapped = unwrapJavaScriptExpression(node).node;
  if (unwrapped !== node) return resolveCallables(unwrapped, context);
  const direct = semanticCallableIdForNode(node);
  if (direct !== null && context.callableById.has(direct))
    return {
      callableIds: [direct],
      complete: true,
      reason: "Direct local callable.",
    };
  if (t.isIdentifier(node)) return resolveIdentifier(node, context);
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    return resolveMemberCall(node, context);
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
  const cached = context.bindingCache.get(node);
  if (cached !== undefined) return cached;
  const binding = resolveSemanticBindingState(context.state, node, node.name);
  if (binding === undefined)
    return {
      callableIds: [],
      complete: false,
      reason: `Unresolved call target ${node.name}.`,
    };
  const read = semanticBindingAtRead(
    binding,
    node,
    context.state.parentsByNode,
  );
  // A full read re-enters the same candidate set wherever the chain returns
  // to this binding. Close that cycle at the binding; position-narrowed reads
  // keep their per-initializer cycle handling.
  const selectsAll = read.binding === binding;
  if (selectsAll && context.seenBindings.has(binding))
    return {
      callableIds: [],
      complete: false,
      cycleDependent: true,
      reason: `Call target initializer cycle at ${binding.name}.`,
    };
  const candidates = resolveBindingCallables(
    read.binding,
    node,
    selectsAll
      ? {
          ...context,
          seenBindings: new Set(context.seenBindings).add(binding),
        }
      : context,
  );
  // Knowing every local candidate does not prove that any write replaced the
  // incoming value, or that a write in another activation precedes this read.
  const covered = read.hasDefiniteInitializer;
  const resolution =
    candidates.complete && !covered
      ? {
          ...candidates,
          complete: false,
          reason: `Call target ${binding.name} may retain an incoming value or an unordered assignment.`,
        }
      : candidates;
  // Key by the immutable read, not binding identity: before/after snapshots
  // differ. Cache cycle-independent partial results too, keeping alias
  // diamonds linear even when their shared leaf has an unknown incoming value.
  if (!resolution.cycleDependent) context.bindingCache.set(node, resolution);
  return resolution;
};

const resolveAlternatives = (
  left: t.Node,
  right: t.Node,
  context: CallResolutionContext,
): LocalCallableResolution => {
  const candidates = [left, right].map((candidate) =>
    resolveCallables(candidate, context),
  );
  return {
    callableIds: uniqueCallableIds(
      candidates.flatMap(({ callableIds }) => callableIds),
    ),
    complete: candidates.every(({ complete }) => complete),
    reason: "Conditional or logical call target has multiple candidates.",
    ...(candidates.some((candidate) => candidate.cycleDependent)
      ? { cycleDependent: true as const }
      : {}),
  };
};

const resolveMemberCall = (
  node: t.MemberExpression | t.OptionalMemberExpression,
  context: CallResolutionContext,
): LocalCallableResolution => {
  const key = semanticStaticPropertyKey(node.property, node.computed);
  // Never read a noncomputed method-key Identifier as a lexical value.
  if (key === null || t.isPrivateName(node.property))
    return {
      callableIds: [],
      complete: false,
      reason: `Unsupported computed class method call target.`,
    };
  const registry = getClassRegistry(context.state);
  const object = unwrapJavaScriptExpression(node.object).node;
  if (t.isSuper(object)) {
    const lookup = lookupSuperMethod(node, key, context.state, registry);
    if (lookup.callableIds.length === 0)
      return {
        callableIds: [],
        complete: false,
        reason: lookup.reason,
      };
    return {
      callableIds: [...lookup.callableIds],
      complete: false,
      reason: lookup.reason,
    };
  }
  if (t.isCallExpression(object) || t.isOptionalCallExpression(object)) {
    const proof = proveGetterReceiver(
      object,
      node,
      context.state,
      context.seenInitializers,
      registry,
    );
    if (proof.status === "unknown")
      return {
        callableIds: [],
        complete: false,
        reason: proof.reason,
      };
    const lookup = lookupUnitOneMethod(proof.classes, key, registry);
    if (lookup.callableIds.length === 0)
      return {
        callableIds: [],
        complete: false,
        reason: lookup.reason,
      };
    return {
      callableIds: [...lookup.callableIds],
      complete: false,
      reason: `Class method ${key} resolves through a getter return.`,
    };
  }
  const proof = proveUnitTwoReceiver(
    node.object,
    node,
    context.state,
    context.seenInitializers,
    registry,
  );
  if (proof.status === "unknown")
    return {
      callableIds: [],
      complete: false,
      reason: proof.reason,
    };
  const lookup = lookupUnitOneMethod(proof.classes, key, registry);
  if (lookup.callableIds.length > MAX_CLASS_CANDIDATES)
    return {
      callableIds: [],
      complete: false,
      reason: `Class method ${key} exceeds the per-site candidate cap.`,
    };
  if (lookup.callableIds.length === 0 && lookup.complete === false)
    return {
      callableIds: [],
      complete: false,
      reason: lookup.reason,
    };
  // A repeated field write keeps the target ambiguous even for one class.
  const single = fieldProofIsSingle(node.object, node, context.state, registry);
  return {
    callableIds: [...lookup.callableIds],
    complete: lookup.complete && single,
    reason: single
      ? lookup.reason
      : `Class method ${key} has multiple field writes.`,
  };
};

const resolveBindingCallables = (
  binding: JavaScriptSemanticBindingState,
  site: t.Identifier,
  context: CallResolutionContext,
): LocalCallableResolution => {
  if (binding.initializers.length === 0)
    return missingBindingInitializer(binding);
  const candidates = binding.initializers.map(
    (initializer): LocalCallableResolution => {
      if (context.seenInitializers.has(initializer))
        return {
          callableIds: [],
          complete: false,
          cycleDependent: true,
          reason: `Call target initializer cycle at ${binding.name}.`,
        };
      return initializer.projection.length === 0
        ? resolveCallables(initializer.node, {
            ...context,
            seenInitializers: new Set([
              ...context.seenInitializers,
              initializer,
            ]),
          })
        : {
            callableIds: [],
            complete: false,
            reason: `Projected call target ${binding.name} is unresolved.`,
          };
    },
  );
  const callableIds = uniqueCallableIds(
    candidates.flatMap((candidate) => candidate.callableIds),
  );
  // Pattern writes are owned reference facts, not ordinary initializers. A
  // read may retain both an earlier callable and a conditional projected
  // replacement. Until projected callable resolution is supported here,
  // preserve known candidates without claiming they cover every target.
  const complete =
    !binding.referenceInitializers.some(
      (initializer) =>
        initializer.assignment &&
        semanticEffectTiming(site, initializer.node, context.state) !== "after",
    ) && candidates.every(({ complete }) => complete);
  const resolution = {
    callableIds,
    complete,
    reason:
      callableIds.length === 1 && complete
        ? "Unique local callable target."
        : `Call target ${binding.name} has ambiguous or unsupported assignments.`,
    ...(candidates.some((candidate) => candidate.cycleDependent)
      ? { cycleDependent: true as const }
      : {}),
  };
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
            parameterAcceptsArgument(callable, location, index, state),
        ),
    )
    .sort((left, right) =>
      compareUnicodeCodePoints(left.bindingId, right.bindingId),
    );
};

const parameterAcceptsArgument = (
  callable: JavaScriptSemanticCallable,
  location: JavaScriptSemanticArgumentFlow["parameterLocation"],
  argumentIndex: number,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const node = state.callableNodesById.get(callable.callableId);
  if (!t.isFunction(node)) return false;
  const parameters = runtimeFunctionParameters(node);
  const parameterIndex = parameters.findIndex((parameter) =>
    javascriptSourceRangeContains(range(parameter), location),
  );
  if (parameterIndex === argumentIndex) return true;
  return (
    parameterIndex >= 0 &&
    parameterIndex < argumentIndex &&
    t.isRestElement(parameters[parameterIndex])
  );
};

const uniqueCallableIds = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareUnicodeCodePoints);
