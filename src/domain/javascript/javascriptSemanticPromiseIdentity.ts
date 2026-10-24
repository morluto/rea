import { semanticExactResultOperand } from "./javascriptSemanticExpressionResults.js";
import * as t from "@babel/types";

import {
  unwrapJavaScriptExpression,
  semanticDirectFunctionReturn,
  semanticStaticPropertyName,
} from "./javascriptAstValues.js";
import { semanticLiteralInitializerProjection } from "./javascriptSemanticLiteralProjection.js";
import {
  semanticInitializerPrecedesRead,
  type SemanticExecutionFrame,
} from "./javascriptSemanticEvaluationOrder.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";
import {
  createUnconditionalEvaluationProof,
  syntaxEvaluationCannotThrow,
} from "./javascriptSymbolicControlFlow.js";
import {
  semanticPropertyPathKeyMatches,
  semanticPrototypeLookupMayChange,
} from "./javascriptSemanticPropertyPaths.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";

const promiseAmbientLookupIntact = (
  property: "constructor" | "then" | "catch" | "finally",
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const selected = ["global", "Promise", "prototype", property];
  return !state.ambientReferenceEffects.some(
    ({ path, node: effect, kind }) =>
      (property === "constructor" || kind === "write") &&
      path.length <= selected.length &&
      path.every((key, index) =>
        semanticPropertyPathKeyMatches(key, selected[index] ?? ""),
      ) &&
      semanticEffectTiming(capture, effect, state) !== "after",
  );
};

/** Constructor entry and allocated result identity share one intrinsic proof. */
export const semanticNativePromiseExecutor = (
  node: t.Function | t.Class,
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.NewExpression | undefined => {
  if (!t.isFunction(node) || node.generator) return undefined;
  const invocation = state.parentsByNode.get(value);
  if (
    !t.isNewExpression(invocation) ||
    invocation.arguments[0] !== value ||
    !isUnshadowedGlobal(invocation.callee, state, "Promise") ||
    invocation.arguments
      .slice(1)
      .some(
        (argument) =>
          t.isSpreadElement(argument) || !syntaxEvaluationCannotThrow(argument),
      )
  )
    return undefined;
  const selected = ["global", "Promise"];
  return state.ambientReferenceEffects.some(
    ({ path, node: effect }) =>
      path.length <= selected.length &&
      path.every((key, index) =>
        semanticPropertyPathKeyMatches(key, selected[index] ?? ""),
      ) &&
      semanticEffectTiming(invocation, effect, state) !== "after",
  )
    ? undefined
    : invocation;
};

const promiseAliasesLookupIntact = (
  aliases: NonNullable<
    ReturnType<typeof semanticExactValueIdentity>
  >["aliases"],
  property: string,
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  includeReferencedObjects = false,
): boolean =>
  aliases.every(({ read }) => {
    const binding = resolveSemanticBindingState(state, read, read.name);
    return (
      binding !== undefined &&
      [...binding.memberWrites, ...binding.escapedPaths].every(
        ({ path, node: effect }) =>
          !(
            semanticPrototypeLookupMayChange(path, property) ||
            (includeReferencedObjects &&
              path.some((_, index) =>
                semanticPrototypeLookupMayChange(
                  path.slice(0, index + 1),
                  property,
                ),
              ))
          ) || semanticEffectTiming(capture, effect, state) === "after",
      )
    );
  });

/** Native await skips Get(then) only while the promise's constructor identity is intact. */
const nativePromiseAwaitIdentityIntact = (
  node: t.Node,
  aliases: NonNullable<
    ReturnType<typeof semanticExactValueIdentity>
  >["aliases"],
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): boolean => {
  if (
    !t.isImportExpression(node) &&
    !(t.isCallExpression(node) && t.isImport(node.callee)) &&
    directLiteralReturn(node, state, true) === undefined
  )
    return true;
  onLiteralProjection?.();
  if (!promiseAmbientLookupIntact("constructor", capture, state)) return false;
  return promiseAliasesLookupIntact(aliases, "constructor", capture, state);
};

/** Inert arguments and simple parameters preserve an exact literal return. */
const directLiteralFunction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.ArrowFunctionExpression | t.FunctionExpression | undefined => {
  if (
    (!t.isCallExpression(node) && !t.isOptionalCallExpression(node)) ||
    !node.arguments.every(
      (argument) =>
        !t.isSpreadElement(argument) && syntaxEvaluationCannotThrow(argument),
    )
  )
    return undefined;
  let callee = unwrapJavaScriptExpression(node.callee).node;
  for (;;) {
    const result = semanticExactResultOperand(callee, state);
    if (result === undefined) break;
    callee = unwrapJavaScriptExpression(result).node;
  }
  return t.isArrowFunctionExpression(callee) || t.isFunctionExpression(callee)
    ? callee
    : undefined;
};

/** The allocated promise is distinct from the async function's returned value. */
export const semanticNativePromiseProducer = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    t.isImportExpression(node) ||
    (t.isCallExpression(node) && t.isImport(node.callee))
  )
    return true;
  const fn = directLiteralFunction(node, state);
  return fn !== undefined && fn.async && !fn.generator;
};

const directLiteralReturn = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  allowAsync = false,
): t.Node | undefined => {
  const fn = directLiteralFunction(node, state);
  return fn === undefined
    ? undefined
    : semanticDirectFunctionReturn(fn, { allowAsync });
};

/** Exact local value identity; aliases do not prove execution order or object validity. */
export const semanticExactValueIdentity = (
  rawNode: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
):
  | {
      readonly node: t.Node;
      readonly aliases: readonly {
        readonly read: t.Identifier;
        readonly initializer: JavaScriptSemanticInitializer;
      }[];
    }
  | undefined => {
  const seen = new Set<string>();
  const aliases: {
    read: t.Identifier;
    initializer: JavaScriptSemanticInitializer;
  }[] = [];
  let node = rawNode;
  for (;;) {
    node = unwrapJavaScriptExpression(node).node;
    const result =
      semanticExactResultOperand(node, state) ??
      directLiteralReturn(node, state);
    if (result !== undefined) {
      node = result;
      continue;
    }
    if (!t.isIdentifier(node) || isUnshadowedGlobal(node, state, "undefined"))
      return { node, aliases };
    const binding = resolveSemanticBindingState(state, node, node.name);
    const initializer = semanticStableInitializer(binding, state);
    if (
      binding === undefined ||
      binding.mutable ||
      initializer === undefined ||
      binding.referenceInitializers.length !== 0 ||
      seen.has(binding.bindingId)
    )
      return undefined;
    seen.add(binding.bindingId);
    const projected = semanticLiteralInitializerProjection(
      initializer,
      state,
      onLiteralProjection,
    );
    if (projected === undefined || projected.projection.length !== 0)
      return undefined;
    aliases.push({ read: node, initializer });
    node = projected.node;
  }
};

type PromiseChainIdentity = NonNullable<
  ReturnType<typeof semanticExactValueIdentity>
>;
type PromiseChainEntry = PromiseChainIdentity | null;
interface PromiseChainIndex {
  readonly literalEffects: JavaScriptSemanticAnalysisState["literalMemberEffects"];
  readonly ambientEffects: JavaScriptSemanticAnalysisState["ambientReferenceEffects"];
  readonly ambientEffectCount: number;
  readonly arrayIterationUnknown: boolean;
  readonly entries: WeakMap<t.Node, PromiseChainEntry>;
}

const promiseChainIndexes = new WeakMap<
  JavaScriptSemanticAnalysisState,
  PromiseChainIndex
>();

/** Final chain proofs are reusable only after all mutation facts are indexed. */
const promiseChainIndex = (
  state: JavaScriptSemanticAnalysisState,
): PromiseChainIndex | undefined => {
  if (state.memberMutationFactsPhase !== "indexed") return undefined;
  const current = promiseChainIndexes.get(state);
  if (
    current !== undefined &&
    current.literalEffects === state.literalMemberEffects &&
    current.ambientEffects === state.ambientReferenceEffects &&
    current.ambientEffectCount === state.ambientReferenceEffects.length &&
    current.arrayIterationUnknown === state.arrayIterationUnknown
  )
    return current;
  const next: PromiseChainIndex = {
    literalEffects: state.literalMemberEffects,
    ambientEffects: state.ambientReferenceEffects,
    ambientEffectCount: state.ambientReferenceEffects.length,
    arrayIterationUnknown: state.arrayIterationUnknown,
    entries: new WeakMap(),
  };
  promiseChainIndexes.set(state, next);
  return next;
};

/** Chaining waits for its receiver only with native method and species identity. */
const nativePromiseChainParent = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection: (() => void) | undefined,
): ReturnType<typeof semanticExactValueIdentity> => {
  if (!t.isCallExpression(node)) return undefined;
  state.memberMutationFactsPhase ??= "requested";
  onLiteralProjection?.();
  const index = promiseChainIndex(state);
  if (index === undefined) return undefined;
  if (index.entries.has(node)) return index.entries.get(node) ?? undefined;

  const chain: {
    readonly call: t.CallExpression;
    readonly member: t.MemberExpression;
    readonly method: "then" | "catch" | "finally";
    readonly receiver: PromiseChainIdentity;
  }[] = [];
  const seen = new Set<t.Node>();
  let current: t.Node = node;
  let native = false;
  for (;;) {
    if (!t.isCallExpression(current) || seen.has(current)) break;
    if (index.entries.has(current)) {
      native = index.entries.get(current) !== null;
      break;
    }
    seen.add(current);
    const member = unwrapJavaScriptExpression(current.callee).node;
    if (!t.isMemberExpression(member)) {
      index.entries.set(current, null);
      break;
    }
    const method = semanticStaticPropertyName(member.property, member.computed);
    if (
      (method !== "then" && method !== "catch" && method !== "finally") ||
      current.arguments.some(
        (argument) =>
          t.isSpreadElement(argument) || !syntaxEvaluationCannotThrow(argument),
      )
    ) {
      index.entries.set(current, null);
      break;
    }
    const receiver = semanticExactValueIdentity(
      member.object,
      state,
      onLiteralProjection,
    );
    if (receiver === undefined) {
      index.entries.set(current, null);
      break;
    }
    chain.push({
      call: current,
      member,
      method,
      receiver,
    });
    const value = receiver.node;
    if (index.entries.has(value)) {
      native = index.entries.get(value) !== null;
      break;
    }
    const executor = t.isNewExpression(value) ? value.arguments[0] : undefined;
    const functionValue =
      executor === undefined
        ? undefined
        : unwrapJavaScriptExpression(executor).node;
    if (
      semanticNativePromiseProducer(value, state) ||
      (executor !== undefined &&
        t.isFunction(functionValue) &&
        semanticNativePromiseExecutor(functionValue, executor, state) === value)
    ) {
      native = true;
      break;
    }
    current = value;
  }

  for (let position = chain.length - 1; position >= 0; position -= 1) {
    const { call, member, method, receiver } = chain[position]!;
    native =
      native &&
      promiseAmbientLookupIntact(method, member, state) &&
      promiseAliasesLookupIntact(receiver.aliases, method, member, state) &&
      promiseAmbientLookupIntact("then", member, state) &&
      promiseAliasesLookupIntact(receiver.aliases, "then", member, state) &&
      promiseAmbientLookupIntact("constructor", call, state) &&
      promiseAliasesLookupIntact(
        receiver.aliases,
        "constructor",
        call,
        state,
        true,
      ) &&
      // Species keys can be computed symbols. Any visible static Promise slot
      // write/escape can hide a custom species constructor that settles early.
      !state.ambientReferenceEffects.some(
        ({ path, node: effect }) =>
          path
            .slice(0, 2)
            .every((key, index) =>
              semanticPropertyPathKeyMatches(
                key,
                ["global", "Promise"][index] ?? "",
              ),
            ) && semanticEffectTiming(call, effect, state) !== "after",
      );
    index.entries.set(call, native ? receiver : null);
  }
  return native ? chain[0]?.receiver : undefined;
};

/** Async adoption preserves values; native handler chains only preserve waits. */
const semanticPromiseProjection = (
  rawNode: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection: (() => void) | undefined,
  followNativeChains: boolean,
): ReturnType<typeof semanticExactValueIdentity> => {
  const aliases: NonNullable<
    ReturnType<typeof semanticExactValueIdentity>
  >["aliases"][number][] = [];
  const seen = new Set<t.Node>();
  let current = rawNode;
  let capture = rawNode;
  for (;;) {
    const result = semanticExactValueIdentity(
      current,
      state,
      onLiteralProjection,
    );
    if (result === undefined || seen.has(result.node)) return undefined;
    if (
      !nativePromiseAwaitIdentityIntact(
        result.node,
        result.aliases,
        capture,
        state,
        onLiteralProjection,
      )
    )
      return undefined;
    seen.add(result.node);
    aliases.push(...result.aliases);
    const chained = followNativeChains
      ? nativePromiseChainParent(result.node, state, onLiteralProjection)
      : undefined;
    if (chained !== undefined) {
      if (
        !promiseAmbientLookupIntact("constructor", capture, state) ||
        !promiseAliasesLookupIntact(
          result.aliases,
          "constructor",
          capture,
          state,
        )
      )
        return undefined;
      current = chained.node;
      aliases.push(...chained.aliases);
      capture = result.node;
      continue;
    }
    const returned = directLiteralReturn(result.node, state, true);
    if (returned === undefined) return { node: result.node, aliases };
    // The wrapper adopts during its own invocation, not a later alias await.
    capture = result.node;
    const value = unwrapJavaScriptExpression(returned).node;
    if (!t.isAwaitExpression(value)) {
      // Async return adopts via Get(then), unlike awaiting a native promise.
      // Request the same alias-aware effect index used by literal projections.
      onLiteralProjection?.();
      const adopted = semanticExactValueIdentity(
        value,
        state,
        onLiteralProjection,
      );
      if (
        !promiseAmbientLookupIntact("then", capture, state) ||
        adopted === undefined ||
        !promiseAliasesLookupIntact(adopted.aliases, "then", capture, state)
      )
        return undefined;
    }
    current = t.isAwaitExpression(value) ? value.argument : value;
  }
};

/** A settled chain needs its receiver to settle, regardless of its handler result. */
export const semanticPromiseSettlementDependency = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): ReturnType<typeof semanticExactValueIdentity> =>
  semanticPromiseProjection(node, state, onLiteralProjection, true);

/** Exact fulfilled-value provenance never substitutes a chain's receiver value. */
export const semanticPromiseFulfilledValueIdentity = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): ReturnType<typeof semanticExactValueIdentity> =>
  semanticPromiseProjection(node, state, onLiteralProjection, false);

const awaitedResults = new WeakMap<
  JavaScriptSemanticAnalysisState,
  {
    readonly literalEffects: JavaScriptSemanticAnalysisState["literalMemberEffects"];
    readonly iterationUnknown: boolean | undefined;
    readonly sites: WeakMap<t.Node, t.AwaitExpression[]>;
  }
>();

/** Alias identity needs initialization proof through directly owned callers. */
const promiseAliasInitializedBeforeRead = (
  initializer: JavaScriptSemanticInitializer,
  read: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
  executionFrames: (node: t.Node) => readonly SemanticExecutionFrame[],
): boolean => {
  return (
    semanticInitializerPrecedesRead({
      initializer: initializer.node,
      read,
      ...(initializer.bindingNode === undefined
        ? {}
        : { bindingNode: initializer.bindingNode }),
      parents: state.parentsByNode,
      initializerContexts: executionFrames(initializer.node),
      readContexts: executionFrames(read),
    }) === true
  );
};

/** The shared activation block owns conditional producer/wait coupling. */
const promiseWaitBoundary = (
  producer: t.Node,
  wait: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): t.Program | t.BlockStatement | t.SwitchCase | undefined => {
  const blocks = new Set<t.Node>();
  let current: t.Node | undefined = producer;
  while (current !== undefined && !t.isFunction(current)) {
    if (
      t.isBlockStatement(current) ||
      t.isProgram(current) ||
      t.isSwitchCase(current)
    )
      blocks.add(current);
    current = parents.get(current);
  }
  current = wait;
  while (current !== undefined && !t.isFunction(current)) {
    if (
      (t.isBlockStatement(current) ||
        t.isProgram(current) ||
        t.isSwitchCase(current)) &&
      blocks.has(current)
    )
      return current;
    current = parents.get(current);
  }
  return undefined;
};

/** Every directly invoked activation between a producer and wait must wait. */
const promiseWaitCoupledToProducer = ({
  producer,
  awaited,
  parents,
  executionFrames,
  reached,
}: {
  readonly producer: t.Node;
  readonly awaited: t.AwaitExpression;
  readonly parents: WeakMap<t.Node, t.Node>;
  readonly executionFrames: (node: t.Node) => readonly SemanticExecutionFrame[];
  readonly reached: ReturnType<typeof createUnconditionalEvaluationProof>;
}): boolean => {
  const producerFrames = executionFrames(producer);
  for (const waitFrame of executionFrames(awaited)) {
    const producerFrame = producerFrames.find(
      ({ owner }) => owner === waitFrame.owner,
    );
    if (producerFrame !== undefined) {
      const boundary = promiseWaitBoundary(
        producerFrame.point,
        waitFrame.point,
        parents,
      );
      return (
        boundary !== undefined &&
        reached(waitFrame.point, boundary, producerFrame.point)
      );
    }
    if (
      !t.isFunction(waitFrame.owner) ||
      !reached(waitFrame.point, waitFrame.owner.body)
    )
      return false;
  }
  return false;
};

/** Index waits using non-recursive direct frames, including initialized aliases. */
export const semanticAwaitedResultSites = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  executionFrames: (node: t.Node) => readonly SemanticExecutionFrame[],
): readonly t.AwaitExpression[] => {
  // Mutation collection can query ordering while filling the same effect map.
  // Only completed facts may be shared with subsequent analysis.
  const completedEffects = state.memberMutationFactsPhase === "indexed";
  let cached = completedEffects ? awaitedResults.get(state) : undefined;
  if (
    cached === undefined ||
    cached.literalEffects !== state.literalMemberEffects ||
    cached.iterationUnknown !== state.arrayIterationUnknown
  ) {
    const index = new WeakMap<t.Node, t.AwaitExpression[]>();
    const reached = createUnconditionalEvaluationProof(state.parentsByNode);
    for (const awaited of state.awaitSites) {
      const result = semanticPromiseSettlementDependency(
        awaited.argument,
        state,
      );
      if (result === undefined) continue;
      // Aliases retain identity only after their own initialization. Reachability
      // is relative to the block shared with the producer: entering a branch
      // can create and await a promise together without reaching either globally.
      if (result.aliases.length !== 0) {
        if (
          result.aliases.some(
            ({ initializer, read }) =>
              !promiseAliasInitializedBeforeRead(
                initializer,
                read,
                state,
                executionFrames,
              ),
          )
        )
          continue;
        if (
          !promiseWaitCoupledToProducer({
            producer: result.node,
            awaited,
            parents: state.parentsByNode,
            executionFrames,
            reached,
          })
        )
          continue;
      }
      const sites = index.get(result.node) ?? [];
      sites.push(awaited);
      index.set(result.node, sites);
    }
    cached = {
      literalEffects: state.literalMemberEffects,
      iterationUnknown: state.arrayIterationUnknown,
      sites: index,
    };
    if (completedEffects && state.memberMutationFactsPhase === "indexed")
      awaitedResults.set(state, cached);
  }
  return cached.sites.get(node) ?? [];
};
