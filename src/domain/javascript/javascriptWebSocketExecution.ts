import * as t from "@babel/types";
import { semanticExpressionCannotThrow } from "./javascriptSemanticExpressionResults.js";
import { semanticKnownArrayIterationAt } from "./javascriptSemanticReferenceSources.js";
import {
  semanticLiteralOwnKeysStable,
  semanticLiteralRestSlots,
} from "./javascriptSemanticLiteralProjection.js";
import {
  semanticPatternCompletionBeforeGeneratorRead,
  semanticPatternSuspendsBeforeTarget,
  semanticGeneratorReadInCleanup,
  semanticGeneratorReadAfterYield,
  semanticIteratorAcquisitionAlwaysFails,
  semanticPatternCompletion,
  semanticPatternCompletionBeforeTarget,
  semanticEvaluationMayBeReached,
  semanticGeneratorBindingPhase,
} from "./javascriptGeneratorConsumerPhases.js";

import {
  unwrapJavaScriptExpression,
  semanticStaticPropertyName,
  readExactJavaScriptLiteral,
  readExactJavaScriptNormalResult,
  semanticFinalObjectMember,
  semanticFinalClassMember,
  semanticStaticPropertyKey,
  javaScriptClassField,
  javaScriptFunctionCanConstruct,
  semanticDirectFunctionReturn,
  semanticDirectFunctionResult,
  semanticFinalObjectSlot,
  semanticValueIsRead,
  semanticValueWriteSite,
  javaScriptExactResultOperand,
  runtimeFunctionParameters,
} from "./javascriptAstValues.js";
import {
  javaScriptOptionalOperandsMayBeSkipped,
  semanticInitializerPrecedesRead,
  type SemanticExecutionFrame,
} from "./javascriptSemanticEvaluationOrder.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  isUnshadowedGlobal,
} from "./javascriptSemanticState.js";
import {
  semanticAwaitedResultSites,
  semanticExactValueIdentity,
  semanticNativePromiseExecutor,
} from "./javascriptSemanticPromiseIdentity.js";
import {
  syntaxMayExitByJump,
  syntaxUnconditionalOperands,
  syntaxEvaluationOperands,
  syntaxEvaluationCannotThrow,
  syntaxMayCompleteNormally,
  syntaxAlwaysThrows,
  syntaxMayReachNextIteration,
  syntaxMayContinue,
  syntaxSwitchCaseTests,
  syntaxEvaluationAlwaysThrows,
  syntaxStaticInitializers,
  syntaxBeforeDefiniteThrow,
  syntaxReachableOperands,
  syntaxOperandAlwaysThrows,
  syntaxMayCompleteWithoutBoundary,
} from "./javascriptSymbolicControlFlow.js";
import { childNodes } from "./javascriptSemanticTraversal.js";
import { semanticAsyncDeclarationFacts } from "./javascriptSemanticResourceAcquisition.js";
import {
  semanticPrototypeLookupMayChange,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import { semanticClassCandidates } from "./javascriptSemanticObjectReferences.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import { semanticOpaqueGlobalMayHaveChanged } from "./javascriptSemanticOpaqueEffects.js";

const webSocketWellKnownSymbols = new Set([
  "asyncIterator",
  "hasInstance",
  "isConcatSpreadable",
  "iterator",
  "match",
  "matchAll",
  "replace",
  "search",
  "species",
  "split",
  "toPrimitive",
  "toStringTag",
  "unscopables",
]);

/** Standard well-known Symbol slots are distinct from every string member. */
const webSocketIntrinsicSymbolKey = (
  raw: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const node = unwrapJavaScriptExpression(raw).node;
  if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node))
    return false;
  const name = semanticStaticPropertyName(node.property, node.computed);
  return (
    webSocketWellKnownSymbols.has(name) &&
    !semanticOpaqueGlobalMayHaveChanged(node, state) &&
    !state.ambientEscapes.covers(["global", "Symbol", name]) &&
    isUnmodifiedGlobalReference(node, state, ["Symbol", name])
  );
};

/** A direct return preserves the value separately from the completed activation. */
const webSocketReturnedOwner = (
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Function | undefined => {
  const statement = state.parentsByNode.get(value);
  if (t.isArrowFunctionExpression(statement) && statement.body === value)
    return semanticDirectFunctionReturn(statement) === value
      ? statement
      : undefined;
  if (!t.isReturnStatement(statement) || statement.argument !== value)
    return undefined;
  const block = state.parentsByNode.get(statement);
  const owner =
    block === undefined ? undefined : state.parentsByNode.get(block);
  return t.isFunction(owner) && semanticDirectFunctionReturn(owner) === value
    ? owner
    : undefined;
};

/** Outward syntax wrappers preserve the expression's runtime identity. */
const webSocketOuterExpression = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  stopAtPatternConsumer = false,
): t.Node => {
  let current = node;
  let identity = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (
      stopAtPatternConsumer &&
      t.isAssignmentExpression(parent) &&
      parent.right === current &&
      (t.isArrayPattern(parent.left) ||
        t.isObjectPattern(parent.left) ||
        webSocketImmediateCaller(parent, state) !== undefined)
    )
      return current;
    if (
      parent !== undefined &&
      // Invocation order is conditional on reaching the body, not on proving
      // that every prefix or target write can finish. A reached call retains
      // this frame independently of the stricter completed-value proof.
      javaScriptExactResultOperand(
        parent,
        () => true,
        syntaxEvaluationCannotThrow,
      ) === current
    ) {
      current = parent;
      identity = parent;
      continue;
    }
    if (
      parent === undefined ||
      unwrapJavaScriptExpression(parent).node !== identity
    ) {
      const owner = webSocketReturnedOwner(current, state);
      const selection =
        owner === undefined
          ? undefined
          : (t.isObjectMethod(owner) || t.isClassMethod(owner)) &&
              owner.kind === "get"
            ? webSocketFreshMethodSelection(owner, owner, state)
            : webSocketImmediateInvocation(owner, state);
      if (selection === undefined) return current;
      current = selection;
      identity = selection;
      continue;
    }
    current = parent;
  }
};

/** A directly selected method/data function on a fresh literal owns its call. */
const webSocketFreshMethodSelection = (
  node: t.Function | t.Class,
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | t.CallExpression
  | t.OptionalCallExpression
  | t.MemberExpression
  | t.OptionalMemberExpression
  | t.ObjectExpression
  | t.ObjectProperty
  | t.RestElement
  | t.SpreadElement
  | undefined => {
  const parent = state.parentsByNode.get(value);
  const property =
    (t.isObjectMethod(node) || t.isClassMethod(node)) &&
    (node.kind === "method" || node.kind === "get" || node.kind === "set")
      ? node
      : (t.isObjectProperty(parent) || javaScriptClassField(parent)) &&
          parent.value === value
        ? parent
        : undefined;
  if (property === undefined) return undefined;
  const container = state.parentsByNode.get(property);
  const literal = t.isClassBody(container)
    ? state.parentsByNode.get(container)
    : container;
  if (!t.isObjectExpression(literal) && !t.isClassExpression(literal))
    return undefined;
  let object = webSocketOuterExpression(literal, state);
  const isStatic =
    !t.isClassMethod(property) && !javaScriptClassField(property)
      ? true
      : property.static;
  if (!isStatic) {
    const construction = state.parentsByNode.get(object);
    if (!t.isNewExpression(construction) || construction.callee !== object)
      return undefined;
    object = webSocketOuterExpression(construction, state);
  }
  const key = semanticStaticPropertyKey(
    property.key,
    "computed" in property && property.computed,
  );
  const final =
    key !== null &&
    (t.isObjectExpression(literal)
      ? semanticFinalObjectMember(
          literal,
          key,
          t.isObjectMethod(property) && property.kind === "set" ? "set" : "get",
        )
      : semanticFinalClassMember(
          literal,
          key,
          isStatic,
          t.isClassMethod(property) && property.kind === "set" ? "set" : "get",
          (node) => webSocketIntrinsicSymbolKey(node, state),
        )) === property;
  if (!final) return undefined;
  if (
    t.isObjectExpression(literal) &&
    t.isObjectMethod(property) &&
    property.kind === "get"
  ) {
    const result = webSocketOuterExpression(literal, state, true);
    const consumer = state.parentsByNode.get(result);
    const pattern =
      t.isVariableDeclarator(consumer) && consumer.init === result
        ? consumer.id
        : t.isAssignmentExpression(consumer, { operator: "=" }) &&
            consumer.right === result
          ? consumer.left
          : undefined;
    if (t.isObjectPattern(pattern)) {
      const selected = pattern.properties.find(
        (item) =>
          t.isObjectProperty(item) &&
          semanticStaticPropertyKey(item.key, item.computed) === key,
      );
      if (t.isObjectProperty(selected))
        // Getter entry follows the selected pattern key. Returning the RHS
        // literal here would incorrectly place the getter before an awaited
        // computed key has finished evaluating.
        return selected;
      const excluded = new Set<string>();
      for (const item of pattern.properties) {
        if (t.isObjectProperty(item)) {
          const name = semanticStaticPropertyKey(item.key, item.computed);
          if (name === null) return undefined;
          excluded.add(name);
        } else if (
          semanticLiteralRestSlots(literal, excluded, item, state)?.some(
            (slot) => slot.kind === "accessor" && slot.node === property,
          )
        )
          return item;
      }
    }
    if (
      (t.isCallExpression(consumer) || t.isOptionalCallExpression(consumer)) &&
      consumer.arguments[1] === result &&
      !javaScriptOptionalOperandsMayBeSkipped(consumer) &&
      !consumer.arguments.some((argument) => t.isSpreadElement(argument))
    ) {
      const callee = unwrapJavaScriptExpression(consumer.callee).node;
      if (
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        semanticStaticPropertyName(callee.property, callee.computed) ===
          "apply" &&
        t.isFunction(
          webSocketStoredCallTarget(
            callee,
            state,
            consumer,
            noCallbackParameters,
          ),
        )
      ) {
        // Native apply reads length, then ascending indices, only after all
        // explicit arguments have completed. A getter is owned by that call,
        // rather than by creation of its array-like object.
        if (key === "length") return consumer;
        const length = semanticFinalObjectMember(literal, "length", "get");
        const value = t.isObjectProperty(length)
          ? readExactJavaScriptLiteral(length.value)
          : undefined;
        const index = key === null ? NaN : Number(key);
        if (
          String(index) === key &&
          Number.isSafeInteger(index) &&
          index >= 0 &&
          value?.found &&
          typeof value.value === "number" &&
          index <
            Math.min(
              Math.max(Math.trunc(value.value), 0),
              Number.MAX_SAFE_INTEGER,
            )
        ) {
          // A later indexed getter is entered only after every earlier Get
          // completes. Prove an own slot for the entire prefix; missing or
          // dynamic slots may select an inherited getter and remain unknown.
          const prior = new Set<string>();
          for (const item of literal.properties) {
            if (t.isSpreadElement(item)) continue;
            const name = semanticStaticPropertyKey(item.key, item.computed);
            const position = name === null ? NaN : Number(name);
            if (
              String(position) !== name ||
              position < 0 ||
              !Number.isSafeInteger(position) ||
              position >= index
            )
              continue;
            const slot = semanticFinalObjectSlot(literal, name!);
            if (slot.kind === "undefined") {
              prior.add(name!);
              continue;
            }
            if (slot.kind !== "member") continue;
            if (t.isObjectMethod(slot.node) && slot.node.kind === "get") {
              const result = semanticDirectFunctionResult(slot.node);
              if (
                result.kind !== "undefined" &&
                (result.kind !== "value" ||
                  !syntaxEvaluationCannotThrow(result.node))
              )
                continue;
            }
            prior.add(name!);
          }
          if (prior.size === index) return consumer;
        }
      }
    }
    if (
      t.isSpreadElement(consumer) &&
      consumer.argument === result &&
      t.isObjectExpression(state.parentsByNode.get(consumer)) &&
      semanticLiteralRestSlots(literal, new Set(), consumer, state)?.some(
        (slot) => slot.kind === "accessor" && slot.node === property,
      )
    )
      return consumer;
  }
  const member = state.parentsByNode.get(object);
  if (
    (!t.isMemberExpression(member) && !t.isOptionalMemberExpression(member)) ||
    member.object !== object
  )
    return undefined;
  return semanticStaticPropertyKey(member.property, member.computed) === key
    ? member
    : undefined;
};

/** Known caller activations order helper lookup independently of lexical source order. */
const webSocketHelperEffectFollowsRead = (
  capture: t.Node,
  effect: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (semanticEffectTiming(capture, effect, state) === "after") return true;
  const frames = webSocketExecutionContexts(capture, state, true).filter(
    ({ owner }) => owner === state.program,
  );
  return (
    frames.length > 0 &&
    frames.every(
      ({ point }) => semanticEffectTiming(point, effect, state) === "after",
    )
  );
};

const noCallbackParameters: ReadonlyMap<string, readonly t.Function[]> =
  new Map();

/** A helper name alone does not prove the selected function is the built-in. */
const webSocketInvocationHelperIntact = (
  receiver: t.Node,
  method: "call" | "apply" | "bind",
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
  parameters: ReadonlyMap<string, readonly t.Function[]> = noCallbackParameters,
  ownedFunction?: t.Function,
  seen: Set<t.Node> = new Set(),
): boolean => {
  state.memberMutationFactsPhase ??= "requested";
  // Discovery requests the index; final call facts are invalidated by its phase.
  if (state.memberMutationFactsPhase !== "indexed") return true;
  const identity = semanticExactValueIdentity(receiver, state);
  const value = identity?.node ?? receiver;
  if (seen.has(value)) return false;
  seen.add(value);
  if (
    identity?.aliases.some(({ read }) => {
      const binding = resolveSemanticBindingState(state, read, read.name);
      return (
        binding === undefined ||
        [...binding.memberWrites, ...binding.escapedPaths].some(
          ({ path, node }) =>
            semanticPrototypeLookupMayChange(path, method) &&
            !webSocketHelperEffectFollowsRead(capture, node, state),
        )
      );
    })
  )
    return false;
  let freshBound = false;
  if (t.isCallExpression(value) || t.isOptionalCallExpression(value)) {
    const callee = unwrapJavaScriptExpression(value.callee).node;
    if (
      (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
      semanticStaticPropertyName(callee.property, callee.computed) === "bind"
    ) {
      if (
        !webSocketInvocationHelperIntact(
          callee.object,
          "bind",
          value,
          state,
          parameters,
          ownedFunction,
          seen,
        )
      )
        return false;
      // The bound allocation has its own helpers, not the target's own slots.
      freshBound = true;
    }
  }
  const binding = t.isIdentifier(value)
    ? resolveSemanticBindingState(state, value, value.name)
    : undefined;
  const functions = t.isFunction(value)
    ? [value]
    : binding?.kind === "parameter"
      ? (parameters.get(binding.bindingId) ?? [])
      : ownedFunction === undefined
        ? []
        : [ownedFunction];
  if (!freshBound && functions.length === 0) return false;
  const selected = ["global", "Function", "prototype", method];
  if (
    state.ambientReferenceEffects.some(
      ({ path, node }) =>
        path.length <= selected.length &&
        path.every((key, index) =>
          semanticPropertyPathKeyMatches(key, selected[index] ?? ""),
        ) &&
        !webSocketHelperEffectFollowsRead(capture, node, state),
    )
  )
    return false;
  return (
    freshBound ||
    functions.every(
      (fn) =>
        !(state.literalMemberEffects?.get(fn) ?? []).some(
          ({ path, node, kind }) =>
            // Exact result exposure is the receiver itself, not an intervening mutator.
            !(
              identity?.node === fn &&
              kind === "escape" &&
              path.length === 0 &&
              node === unwrapJavaScriptExpression(receiver).node
            ) &&
            semanticPrototypeLookupMayChange(path, method) &&
            !webSocketHelperEffectFollowsRead(capture, node, state),
        ),
    )
  );
};

/** Exact aliases identify a value; each read still needs its initialization event. */
const webSocketAliasesInitialized = (
  exact: NonNullable<ReturnType<typeof semanticExactValueIdentity>>,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  exact.aliases.every(({ read, initializer }) =>
    t.isFunctionDeclaration(initializer.node)
      ? semanticExpressionCannotThrow(read, state, (node) =>
          webSocketExecutionContexts(node, state),
        )
      : semanticInitializerPrecedesRead({
          initializer: initializer.node,
          read,
          ...(initializer.bindingNode === undefined
            ? {}
            : { bindingNode: initializer.bindingNode }),
          parents: state.parentsByNode,
          initializerContexts: webSocketExecutionContexts(
            initializer.node,
            state,
          ),
          readContexts: webSocketExecutionContexts(read, state),
        }) === true,
  );

/** Normalize actual invocation separately from creating a bound function. */
const webSocketStoredCallTarget = (
  raw: t.Node,
  state: JavaScriptSemanticAnalysisState,
  capture: t.Node,
  parameters: ReadonlyMap<string, readonly t.Function[]>,
  checkInitialization = true,
  checkHelperIntegrity = true,
): t.Node | undefined => {
  let current = unwrapJavaScriptExpression(raw).node;
  if (t.isMemberExpression(current) || t.isOptionalMemberExpression(current)) {
    const method = semanticStaticPropertyName(
      current.property,
      current.computed,
    );
    if (method === "bind") return undefined;
    if (method === "call" || method === "apply") {
      // A constructor selection of the built-in helper never enters its receiver.
      if (t.isNewExpression(capture)) return undefined;
      if (
        method === "apply" &&
        (t.isCallExpression(capture) || t.isOptionalCallExpression(capture))
      ) {
        const argumentList = capture.arguments[1];
        if (argumentList !== undefined && !t.isSpreadElement(argumentList)) {
          const result = readExactJavaScriptNormalResult(
            argumentList,
            syntaxEvaluationCannotThrow,
          );
          // CreateListFromArrayLike rejects every non-nullish primitive before
          // the receiver body can run. Unknown values remain possible objects.
          if (
            result.found &&
            result.value !== null &&
            result.value !== undefined &&
            typeof result.value !== "object" &&
            typeof result.value !== "function"
          )
            return undefined;
        }
      }
      if (
        checkHelperIntegrity &&
        !webSocketInvocationHelperIntact(
          current.object,
          method,
          current,
          state,
          parameters,
        )
      )
        return undefined;
      current = current.object;
    }
  }
  const seen = new Set<t.Node>();
  while (!seen.has(current)) {
    seen.add(current);
    const exact = semanticExactValueIdentity(current, state);
    if (
      checkInitialization &&
      exact !== undefined &&
      !webSocketAliasesInitialized(exact, state)
    )
      return undefined;
    const value = exact?.node ?? current;
    // A bind call is followed only when its result is itself the callee.
    if (t.isCallExpression(value) || t.isOptionalCallExpression(value)) {
      const callee = unwrapJavaScriptExpression(value.callee).node;
      if (
        (t.isMemberExpression(callee) ||
          t.isOptionalMemberExpression(callee)) &&
        semanticStaticPropertyName(callee.property, callee.computed) === "bind"
      ) {
        if (
          checkHelperIntegrity &&
          !webSocketInvocationHelperIntact(
            callee.object,
            "bind",
            value,
            state,
            parameters,
          )
        )
          return undefined;
        current = callee.object;
        continue;
      }
    }
    return t.isNewExpression(capture) &&
      (t.isFunction(value) || t.isClass(value)) &&
      !javaScriptFunctionCanConstruct(value)
      ? undefined
      : value;
  }
  return undefined;
};

interface WebSocketExecutionFacts {
  readonly effects: JavaScriptSemanticAnalysisState["literalMemberEffects"];
  readonly phase: JavaScriptSemanticAnalysisState["memberMutationFactsPhase"];
  readonly callCount: number;
  readonly executorSettlementUses: WeakMap<
    t.Function,
    readonly t.Identifier[] | null
  >;
  storedCalls?: WeakMap<t.Function | t.Class, readonly WebSocketStoredCall[]>;
  readonly immediateCallers: WeakMap<t.Node, t.Function | null>;
  readonly suspensions: WebSocketSuspensionFacts;
  readonly bodySuspensions: WeakMap<
    t.Node,
    { readonly value: boolean | undefined }
  >;
  readonly classPrefixes: WeakMap<
    t.Class,
    {
      readonly keys: ReadonlyMap<t.Node, WebSocketSuspension | null>;
      readonly statics: ReadonlyMap<t.Node, WebSocketSuspension | null>;
    }
  >;
}

type WebSocketCallSite = JavaScriptSemanticAnalysisState["callSites"][number];

interface WebSocketStoredCall {
  readonly call: WebSocketCallSite;
  readonly parameters: ReadonlyMap<string, readonly t.Function[]>;
  readonly activation?: {
    readonly owner: t.Function;
    readonly call: WebSocketCallSite;
  };
}
const executionFacts = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WebSocketExecutionFacts
>();

/** Every derived activation and suspension belongs to one effect-index version. */
const webSocketExecutionFacts = (
  state: JavaScriptSemanticAnalysisState,
): WebSocketExecutionFacts => {
  let facts = executionFacts.get(state);
  if (
    facts === undefined ||
    facts.effects !== state.literalMemberEffects ||
    facts.phase !== state.memberMutationFactsPhase ||
    facts.callCount !== state.callSites.length
  ) {
    facts = {
      effects: state.literalMemberEffects,
      phase: state.memberMutationFactsPhase,
      callCount: state.callSites.length,
      executorSettlementUses: new WeakMap(),
      immediateCallers: new WeakMap(),
      suspensions: {
        completed: new WeakMap(),
        exits: new WeakMap(),
        prefixes: new WeakMap(),
      },
      bodySuspensions: new WeakMap(),
      classPrefixes: new WeakMap(),
    };
    executionFacts.set(state, facts);
  }
  return facts;
};

/** An ignored async return is separate from the resolve/reject capabilities. */
const webSocketExecutorSettlesAfterRead = (
  executor: t.Function,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const cache = webSocketExecutionFacts(state).executorSettlementUses;
  let uses = cache.get(executor);
  if (uses === undefined) {
    const runtimeParameters = runtimeFunctionParameters(executor);
    const parameters = runtimeParameters.slice(0, 2);
    const bindings = new Set<string>();
    for (const parameter of parameters) {
      if (!t.isIdentifier(parameter)) {
        cache.set(executor, null);
        return false;
      }
      const binding = resolveSemanticBindingState(
        state,
        parameter,
        parameter.name,
      );
      if (binding === undefined) {
        cache.set(executor, null);
        return false;
      }
      bindings.add(binding.bindingId);
    }
    const selected: t.Identifier[] = [];
    const pending: t.Node[] = [executor.body, ...runtimeParameters.slice(2)];
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const node = pending[cursor];
      if (node === undefined) continue;
      // Property names, labels and binding declarations do not expose a
      // settlement capability even when their spelling matches its parameter.
      const parent = state.parentsByNode.get(node);
      if (
        t.isIdentifier(node) &&
        parent !== undefined &&
        t.isReferenced(node, parent, state.parentsByNode.get(parent))
      ) {
        // Dynamic scope and an ordinary executor's arguments object can expose
        // settlement capabilities without a named parameter reference.
        if (
          node.name === "eval" ||
          (!t.isArrowFunctionExpression(executor) && node.name === "arguments")
        ) {
          cache.set(executor, null);
          return false;
        }
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding !== undefined && bindings.has(binding.bindingId))
          selected.push(node);
      }
      // Include nested closures: exposing either capability before the read
      // makes settlement uncertain even when the closure's body appears later.
      pending.push(...childNodes(node));
    }
    uses = selected;
    cache.set(executor, uses);
  }
  const repeats = (node: t.Node): boolean => {
    let current: t.Node | undefined = node;
    while (current !== undefined && current !== executor) {
      if (t.isLoop(current)) return true;
      current = state.parentsByNode.get(current);
    }
    return false;
  };
  if (uses === null || repeats(read)) return false;
  const readContexts = webSocketExecutionContexts(read, state, true);
  return uses.every(
    (use) =>
      !repeats(use) &&
      semanticInitializerPrecedesRead({
        initializer: read,
        read: use,
        parents: state.parentsByNode,
        initializerContexts: readContexts,
        readContexts: webSocketExecutionContexts(use, state, true),
      }) === true,
  );
};

/** The function that owns a runtime parameter binding. */
const webSocketParameterOwner = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Function | undefined => {
  let current = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return undefined;
    if (t.isFunction(parent)) return parent;
    current = parent;
  }
};

/** Exact immutable aliases share one call-site index, including their lexical caller. */
const webSocketStoredCalls = (
  node: t.Function | t.Class,
  state: JavaScriptSemanticAnalysisState,
) => {
  const facts = webSocketExecutionFacts(state);
  let calls = facts.storedCalls;
  if (calls === undefined) {
    calls = new WeakMap();
    // Install before identity queries: projections may reenter execution facts.
    facts.storedCalls = calls;
    type ParameterSupplier = {
      readonly bindingId: string;
      readonly fn: t.Function;
      readonly owner: t.Function;
      readonly call: WebSocketCallSite;
    };
    const suppliersByParameter = new Map<string, ParameterSupplier[]>();
    const candidates: (WebSocketStoredCall & {
      readonly fn: t.Function | t.Class;
    })[] = [];
    const indexedCandidates = new WeakMap<
      t.Function | t.Class,
      WeakMap<WebSocketCallSite, Set<t.Node>>
    >();
    for (const call of state.callSites) {
      // Callee/argument/substitution evaluation must finish before entry. A
      // definite prefix failure is not an activation of the selected body.
      if (syntaxEvaluationAlwaysThrows(call)) continue;
      // Tags receive a synthetic template object before their substitutions;
      // ordinary argument offsets do not prove callback parameter ownership.
      if (t.isTaggedTemplateExpression(call)) continue;
      for (const argument of call.arguments.flatMap<t.Node>((argument) =>
        t.isArrayExpression(argument)
          ? [argument, ...argument.elements.filter((item) => item !== null)]
          : [argument],
      )) {
        const selected = webSocketArgumentParameter(argument, state);
        if (selected === undefined || !t.isIdentifier(selected.parameter))
          continue;
        const binding = resolveSemanticBindingState(
          state,
          selected.parameter,
          selected.parameter.name,
        );
        const exact = semanticExactValueIdentity(argument, state);
        const owner = webSocketParameterOwner(selected.parameter, state);
        if (
          binding?.kind === "parameter" &&
          binding.definitions.length === 1 &&
          binding.initializers.length === 0 &&
          binding.referenceInitializers.length === 0 &&
          exact !== undefined &&
          t.isFunction(exact.node) &&
          owner !== undefined
        ) {
          const supplier = {
            bindingId: binding.bindingId,
            fn: exact.node,
            owner,
            call,
          };
          const suppliers = suppliersByParameter.get(binding.bindingId) ?? [];
          suppliers.push(supplier);
          suppliersByParameter.set(binding.bindingId, suppliers);
        }
      }
    }
    const addCandidates = (
      call: WebSocketCallSite,
      parameters: ReadonlyMap<string, readonly t.Function[]>,
      activation?: WebSocketStoredCall["activation"],
    ): void => {
      const target = webSocketStoredCallTarget(
        t.isTaggedTemplateExpression(call) ? call.tag : call.callee,
        state,
        call,
        parameters,
        false,
      );
      const binding = t.isIdentifier(target)
        ? resolveSemanticBindingState(state, target, target.name)
        : undefined;
      const functions =
        t.isFunction(target) || (t.isClass(target) && t.isNewExpression(call))
          ? [target]
          : binding?.kind === "parameter"
            ? (parameters.get(binding.bindingId) ?? [])
            : [];
      for (const fn of new Set(functions)) {
        if (t.isNewExpression(call) && !javaScriptFunctionCanConstruct(fn))
          continue;
        let byCall = indexedCandidates.get(fn);
        if (byCall === undefined)
          indexedCandidates.set(fn, (byCall = new WeakMap()));
        let owners = byCall.get(call);
        if (owners === undefined) byCall.set(call, (owners = new Set()));
        const activationCall = activation?.call ?? call;
        if (owners.has(activationCall)) continue;
        owners.add(activationCall);
        const candidate =
          activation === undefined
            ? { fn, call, parameters }
            : { fn, call, parameters, activation };
        calls?.set(fn, [...(calls.get(fn) ?? []), candidate]);
        candidates.push(candidate);
      }
    };
    for (const call of state.callSites) {
      if (syntaxEvaluationAlwaysThrows(call)) continue;
      addCandidates(call, noCallbackParameters);
      const rawTarget = webSocketStoredCallTarget(
        t.isTaggedTemplateExpression(call) ? call.tag : call.callee,
        state,
        call,
        noCallbackParameters,
        false,
        false,
      );
      const targetBinding = t.isIdentifier(rawTarget)
        ? resolveSemanticBindingState(state, rawTarget, rawTarget.name)
        : undefined;
      if (targetBinding?.kind !== "parameter") continue;
      for (const supplier of suppliersByParameter.get(
        targetBinding.bindingId,
      ) ?? []) {
        const parameters = new Map<string, readonly t.Function[]>([
          [supplier.bindingId, [supplier.fn]],
        ]);
        addCandidates(call, parameters, {
          owner: supplier.owner,
          call: supplier.call,
        });
      }
    }
    // Initialization depends on caller activations. Admit against the complete
    // candidate graph, not the source-order prefix present while indexing.
    const initialized: NonNullable<WebSocketExecutionFacts["storedCalls"]> =
      new WeakMap();
    for (const candidate of candidates) {
      const { fn, call, parameters } = candidate;
      if (
        webSocketStoredCallTarget(
          t.isTaggedTemplateExpression(call) ? call.tag : call.callee,
          state,
          call,
          parameters,
        ) !== undefined
      )
        initialized.set(fn, [...(initialized.get(fn) ?? []), candidate]);
    }
    calls = initialized;
    // Discovery of candidate callers can populate derived caches. Publish only
    // the admitted graph and discard those provisional activation facts.
    executionFacts.delete(state);
    webSocketExecutionFacts(state).storedCalls = calls;
  }
  return calls.get(node) ?? [];
};

/** Binding a literal defers it only until that bound result is invoked. */
const webSocketImmediateInvocation = (
  node: t.Function | t.Class,
  state: JavaScriptSemanticAnalysisState,
):
  | t.CallExpression
  | t.OptionalCallExpression
  | t.NewExpression
  | t.TaggedTemplateExpression
  | t.Decorator
  | t.MemberExpression
  | t.OptionalMemberExpression
  | t.ObjectExpression
  | t.ObjectProperty
  | t.RestElement
  | t.SpreadElement
  | undefined => {
  const value = webSocketOuterExpression(node, state);
  const selection = webSocketFreshMethodSelection(node, value, state);
  // Reading an accessor invokes its getter before any returned value is called.
  if (
    selection !== undefined &&
    (t.isObjectMethod(node) || t.isClassMethod(node)) &&
    node.kind === "get"
  )
    return semanticValueIsRead(selection, state.parentsByNode)
      ? selection
      : undefined;
  if (
    selection !== undefined &&
    (t.isObjectMethod(node) || t.isClassMethod(node)) &&
    node.kind === "set"
  )
    return semanticValueWriteSite(selection, state.parentsByNode) !== undefined
      ? selection
      : undefined;
  if (selection === undefined) {
    const promise = semanticNativePromiseExecutor(node, value, state);
    if (promise !== undefined) return promise;
  }
  let callee =
    selection === undefined
      ? value
      : webSocketOuterExpression(selection, state);
  for (;;) {
    let invocation = state.parentsByNode.get(callee);
    let binds = false;
    if (
      (t.isMemberExpression(invocation) ||
        t.isOptionalMemberExpression(invocation)) &&
      invocation.object === callee
    ) {
      const member = semanticStaticPropertyName(
        invocation.property,
        invocation.computed,
      );
      if (member !== "call" && member !== "apply" && member !== "bind")
        return undefined;
      const receiver = invocation.object;
      binds = member === "bind";
      callee = webSocketOuterExpression(invocation, state);
      invocation = state.parentsByNode.get(callee);
      if (t.isNewExpression(invocation)) return undefined;
      if (
        t.isFunction(node) &&
        (t.isCallExpression(invocation) ||
          t.isOptionalCallExpression(invocation)) &&
        !webSocketInvocationHelperIntact(
          receiver,
          member,
          invocation,
          state,
          noCallbackParameters,
          node,
        )
      )
        return undefined;
    }
    if (t.isDecorator(invocation)) {
      if (invocation.expression !== callee) return undefined;
    } else if (t.isTaggedTemplateExpression(invocation)) {
      if (invocation.tag !== callee) return undefined;
    } else if (
      (!t.isCallExpression(invocation) &&
        !t.isOptionalCallExpression(invocation) &&
        !t.isNewExpression(invocation)) ||
      invocation.callee !== callee
    ) {
      const stored = webSocketStoredCalls(node, state);
      return stored.length === 1 ? stored[0]?.call : undefined;
    }
    if (t.isNewExpression(invocation) && !javaScriptFunctionCanConstruct(node))
      return undefined;
    if (!binds)
      return syntaxEvaluationAlwaysThrows(invocation) ? undefined : invocation;
    callee = webSocketOuterExpression(invocation, state);
  }
};

type WebSocketSuspension =
  | t.AwaitExpression
  | t.YieldExpression
  | t.ForOfStatement
  | t.BlockStatement;

const loopJumpFacts = new WeakMap<t.Node, boolean>();
/** An abrupt loop path cannot prove normal body completion before its test/update. */
const webSocketBodyMayJump = (body: t.Node): boolean => {
  const known = loopJumpFacts.get(body);
  if (known !== undefined) return known;
  const mayJump = syntaxMayExitByJump(body);
  loopJumpFacts.set(body, mayJump);
  return mayJump;
};

/** A wait precedes every scope exit only if no earlier throw/jump can bypass it. */
const webSocketEveryExitSuspension = (
  block: t.BlockStatement,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  const cache = webSocketSuspensionFacts(state).exits;
  const known = cache.get(block);
  if (known !== undefined) return known ?? undefined;
  const pending: t.Node[] = [block];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const node = unwrapJavaScriptExpression(next).node;
    if (
      t.isAwaitExpression(node) &&
      syntaxEvaluationCannotThrow(node.argument)
    ) {
      cache.set(block, node);
      return node;
    }
    if (t.isBlockStatement(node)) {
      pending.push(...node.body.toReversed());
      continue;
    }
    // A successfully acquired null async resource still schedules a disposal
    // await on every exit, including throw/return/break. The declaration itself
    // does not suspend, and a possibly throwing initializer cannot prove this.
    if (t.isVariableDeclaration(node) && node.kind === "await using") {
      const resource = semanticAsyncDeclarationFacts(node, state);
      if (resource.acquisition === "acquired" && resource.disposal === "wait") {
        cache.set(block, block);
        return block;
      }
      // Registration itself never invokes the disposer. A completed earlier
      // declaration cannot hide a later resource in the same disposal scope.
      if (resource.completion === "completed") continue;
    }
    if (syntaxEvaluationAlwaysThrows(node)) {
      pending.length = 0;
      pending.push(...syntaxBeforeDefiniteThrow(node).toReversed());
      continue;
    }
    if (syntaxEvaluationCannotThrow(node)) continue;
    if (t.isVariableDeclarator(node)) {
      const binding = webSocketBindingCompletion(
        node.id,
        node.init ?? undefined,
        state,
      );
      if (
        node.init != null &&
        syntaxEvaluationCannotThrow(node.init) &&
        binding.phase === "suspended" &&
        binding.suspension !== undefined
      ) {
        cache.set(block, binding.suspension);
        return binding.suspension;
      }
      if (!t.isIdentifier(node.id)) {
        pending.length = 0;
      }
      if (node.init != null) pending.push(node.init);
      continue;
    }
    if (t.isExpressionStatement(node)) pending.push(node.expression);
    else if (t.isThrowStatement(node) || t.isReturnStatement(node)) {
      // Abrupt completion discards every later statement, but evaluates its
      // argument before entering a finalizer.
      pending.length = 0;
      if (node.argument != null) pending.push(node.argument);
    } else if (t.isSequenceExpression(node))
      pending.push(...node.expressions.toReversed());
    else if (
      t.isVariableDeclaration(node) &&
      (node.kind === "var" || node.kind === "let" || node.kind === "const") &&
      node.declarations.length > 0
    ) {
      pending.push(...node.declarations.toReversed());
    } else if (t.isDoWhileStatement(node)) {
      pending.length = 0;
      if (
        syntaxEvaluationCannotThrow(node.body) &&
        !webSocketBodyMayJump(node.body)
      )
        pending.push(node.test);
      pending.push(node.body);
    } else if (
      t.isIfStatement(node) ||
      t.isConditionalExpression(node) ||
      t.isLogicalExpression(node)
    ) {
      const selected = syntaxUnconditionalOperands(node);
      // Two operands prove a selected branch; a lone test cannot skip an
      // uncertain branch that might throw before a later statement's wait.
      if (selected?.length !== 2) break;
      pending.push(...selected.toReversed());
    } else break;
  }
  cache.set(block, null);
  return undefined;
};

/** A definite throw enters its binding before the handler body can run. */
const webSocketMandatoryHandler = (
  node: t.TryStatement,
): t.CatchClause | undefined =>
  node.handler != null && syntaxAlwaysThrows(node.block)
    ? node.handler
    : undefined;

/** Children completed in order if this straight-line node completes normally. */
const webSocketOrderedEvaluation = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): readonly t.Node[] => {
  // Binding work uses the shared pattern completion owner, not a syntax-only
  // walk that would evaluate computed keys before nullish coercion.
  if (t.isCatchClause(node)) return [node.body];
  if (t.isBlockStatement(node)) {
    const reachable: t.Node[] = [];
    for (const statement of node.body) {
      reachable.push(statement);
      if (!syntaxMayCompleteNormally(statement)) break;
    }
    return reachable;
  }
  const operands =
    syntaxUnconditionalOperands(node) ?? syntaxEvaluationOperands(node);
  if (operands !== undefined) {
    const failed = operands.findIndex((operand) =>
      syntaxOperandAlwaysThrows(node, operand),
    );
    return failed < 0 ? operands : operands.slice(0, failed + 1);
  }
  if (t.isLabeledStatement(node)) {
    const prefix: t.Node[] = [];
    for (const statement of t.isBlockStatement(node.body)
      ? node.body.body
      : [node.body]) {
      if (webSocketBodyMayJump(statement)) break;
      prefix.push(statement);
    }
    const exit = t.isBlockStatement(node.body)
      ? webSocketEveryExitSuspension(node.body, state)
      : undefined;
    return exit === undefined ? prefix : [...prefix, exit];
  }
  if (t.isWithStatement(node)) return [node.object, node.body];
  if (t.isSwitchStatement(node)) return [node.discriminant];
  // Every normally completed loop evaluates its initial test, but its body
  // and updates may never execute. A do/while body precedes its first test.
  if (t.isWhileStatement(node)) return [node.test];
  if (t.isDoWhileStatement(node))
    return !syntaxMayCompleteNormally(node.body) ||
      webSocketBodyMayJump(node.body)
      ? t.isBlockStatement(node.body)
        ? [webSocketEveryExitSuspension(node.body, state)].filter(
            (item) => item !== undefined,
          )
        : []
      : [node.body, node.test];
  if (t.isTryStatement(node))
    return [
      node.handler == null
        ? node.block
        : webSocketEveryExitSuspension(node.block, state),
      webSocketMandatoryHandler(node),
      node.finalizer,
    ].filter((item) => item != null);
  if (t.isForStatement(node))
    return [node.init, node.test].filter((element) => element != null);
  // Conditional/short-circuit branches, nested functions and try/catch do not
  // establish a suspension on every path to the following expression.
  return [];
};

interface WebSocketSuspensionFacts {
  readonly completed: WeakMap<t.Node, WebSocketSuspension | null>;
  readonly exits: WeakMap<t.BlockStatement, WebSocketSuspension | null>;
  readonly prefixes: WeakMap<t.Node, ReadonlyMap<t.Node, WebSocketSuspension>>;
}
/** Resource acquisition and cached prefixes share the activation's version. */
const webSocketSuspensionFacts = (
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspensionFacts => {
  return webSocketExecutionFacts(state).suspensions;
};

/** Catch and loop heads consume the same ordered binding facts as destructuring. */
const webSocketBindingCompletion = (
  pattern: t.Node,
  value: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
  ownedResultEscape?: t.Node,
  normalContinuation = false,
): {
  readonly phase: ReturnType<typeof semanticPatternCompletion>;
  readonly suspension: WebSocketSuspension | undefined;
} => {
  let suspension: WebSocketSuspension | undefined;
  const phase = semanticPatternCompletion(
    pattern,
    value,
    state,
    (operand) => {
      const completed = webSocketCompletedSuspension(operand, state);
      if (completed !== undefined) suspension = completed;
      return completed !== undefined;
    },
    (node) => webSocketExecutionContexts(node, state, true),
    ownedResultEscape,
    normalContinuation,
  );
  // Keep a wait already completed before an uncertain write. Reaching a body
  // proves that write finished; this does not credit any work after uncertainty.
  return {
    phase,
    suspension:
      phase === "suspended" || phase === "suspended-unproven"
        ? suspension
        : undefined,
  };
};

const webSocketCatchBinding = (
  handler: t.CatchClause,
  state: JavaScriptSemanticAnalysisState,
) => {
  const owner = state.parentsByNode.get(handler);
  const statement =
    t.isTryStatement(owner) && owner.block.body.length === 1
      ? owner.block.body[0]
      : undefined;
  return handler.param == null
    ? undefined
    : webSocketBindingCompletion(
        handler.param,
        t.isThrowStatement(statement) ? statement.argument : undefined,
        state,
      );
};

/** Successful completion crosses the last suspension in this straight-line node. */
const webSocketCompletedSuspension = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  if (
    syntaxEvaluationAlwaysThrows(node) ||
    (t.isForOfStatement(node) &&
      semanticIteratorAcquisitionAlwaysFails(node.right, state))
  )
    return undefined;
  const cached = webSocketSuspensionFacts(state).completed;
  const existing = cached.get(node);
  if (existing !== undefined) return existing ?? undefined;
  const pending = [node];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) continue;
    const current = unwrapJavaScriptExpression(next).node;
    if (t.isCatchClause(current)) {
      const binding = webSocketCatchBinding(current, state);
      if (
        binding !== undefined &&
        binding.phase !== "completed" &&
        binding.phase !== "suspended"
      )
        continue;
      if (binding?.suspension !== undefined) {
        cached.set(node, binding.suspension);
        return binding.suspension;
      }
    }
    // Disposal belongs to successful scope exit, never the declaration point.
    if (
      t.isBlockStatement(current) &&
      current.body.some(
        (statement) =>
          t.isVariableDeclaration(statement) &&
          statement.kind === "await using" &&
          // This query is conditional on normal block completion: reaching the
          // next statement proves an unknown acquisition succeeded. A known
          // failure cannot establish that completed exit.
          semanticAsyncDeclarationFacts(statement, state).completion !==
            "failed" &&
          semanticAsyncDeclarationFacts(statement, state).disposal !== "abrupt",
      )
    ) {
      cached.set(node, current);
      return current;
    }
    const delegateOwner =
      t.isYieldExpression(current) && current.delegate
        ? webSocketSuspensionOwner(current, state)
        : undefined;
    if (
      (t.isAwaitExpression(current) &&
        !syntaxEvaluationAlwaysThrows(current.argument)) ||
      (t.isForOfStatement(current) &&
        current.await &&
        !semanticIteratorAcquisitionAlwaysFails(current.right, state)) ||
      (t.isYieldExpression(current) &&
        (!current.delegate ||
          // Async delegation awaits the iterator result even when it is done;
          // synchronous delegation can finish without yielding at all.
          (t.isFunction(delegateOwner) && delegateOwner.async)))
    ) {
      cached.set(node, current);
      return current;
    }
    if (
      (t.isIfStatement(current) || t.isConditionalExpression(current)) &&
      current.alternate != null
    ) {
      const test = readExactJavaScriptLiteral(current.test);
      if (
        !test.found &&
        webSocketCompletedSuspension(current.consequent, state) !== undefined &&
        webSocketCompletedSuspension(current.alternate, state) !== undefined
      ) {
        const result = webSocketCompletedSuspension(current.consequent, state);
        cached.set(node, result ?? null);
        return result;
      }
    }
    for (const child of webSocketOrderedEvaluation(current, state))
      pending.push(child);
  }
  cached.set(node, null);
  return undefined;
};

/** Break/return/throw paths bypass updates; only a continuing path can skip its wait. */
const webSocketUpdateSuspension = (
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined =>
  syntaxMayContinue(body)
    ? t.isBlockStatement(body)
      ? webSocketEveryExitSuspension(body, state)
      : undefined
    : webSocketCompletedSuspension(body, state);

/** Index sibling phases once rather than rescan a suspended body per socket. */
const webSocketPrecedingSuspension = (
  parent: t.Node,
  child: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  if (
    (t.isIfStatement(parent) || t.isConditionalExpression(parent)) &&
    (child === parent.consequent || child === parent.alternate)
  )
    return webSocketCompletedSuspension(parent.test, state);
  if (
    (t.isLogicalExpression(parent) ||
      (t.isAssignmentExpression(parent) &&
        ["&&=", "||=", "??="].includes(parent.operator))) &&
    child === parent.right
  )
    return webSocketCompletedSuspension(parent.left, state);
  if (t.isTryStatement(parent) && child === parent.handler)
    return webSocketEveryExitSuspension(parent.block, state);
  if (t.isTryStatement(parent) && child === parent.finalizer) {
    const handler = webSocketMandatoryHandler(parent);
    return (
      (handler === undefined
        ? undefined
        : // A finalizer is also entered when binding throws; normal handler
          // completion cannot prove that its body ran on every exit.
          handler.param == null || t.isIdentifier(handler.param)
          ? webSocketEveryExitSuspension(handler.body, state)
          : undefined) ?? webSocketEveryExitSuspension(parent.block, state)
    );
  }
  if (t.isCatchClause(parent) && child === parent.body)
    return webSocketCatchBinding(parent, state)?.suspension;
  if (
    t.isSwitchStatement(parent) &&
    parent.cases.includes(child as t.SwitchCase)
  )
    return webSocketCompletedSuspension(parent.discriminant, state);
  if (t.isSwitchCase(parent) && child !== parent.test) {
    const selection = state.parentsByNode.get(parent);
    if (t.isSwitchStatement(selection)) {
      for (const test of syntaxSwitchCaseTests(
        selection,
        parent,
      ).toReversed()) {
        const suspension = webSocketCompletedSuspension(test, state);
        if (suspension !== undefined) return suspension;
      }
    }
  }
  if (
    t.isOptionalMemberExpression(parent) &&
    parent.computed &&
    child === parent.property
  )
    return webSocketCompletedSuspension(parent.object, state);
  if (
    t.isForOfStatement(parent) &&
    parent.await &&
    (child === parent.body || child === parent.left)
  )
    return semanticIteratorAcquisitionAlwaysFails(parent.right, state)
      ? undefined
      : parent;
  if (
    (t.isForOfStatement(parent) || t.isForInStatement(parent)) &&
    (child === parent.body || child === parent.left)
  ) {
    if (child === parent.body) {
      const pattern = t.isVariableDeclaration(parent.left)
        ? parent.left.declarations[0]?.id
        : parent.left;
      const iterable = unwrapJavaScriptExpression(parent.right).node;
      const value =
        t.isForOfStatement(parent) &&
        t.isArrayExpression(iterable) &&
        state.arrayIterationUnknown !== true &&
        iterable.elements.length === 1 &&
        !t.isSpreadElement(iterable.elements[0])
          ? (iterable.elements[0] ?? undefined)
          : undefined;
      if (pattern !== undefined) {
        const binding = webSocketBindingCompletion(pattern, value, state);
        if (
          binding.phase === "blocked" ||
          binding.phase === "suspended-blocked"
        )
          return undefined;
        if (binding.suspension !== undefined) return binding.suspension;
      }
    }
    return webSocketCompletedSuspension(parent.right, state);
  }
  if (
    (t.isWhileStatement(parent) || t.isForStatement(parent)) &&
    (child === parent.body ||
      (t.isForStatement(parent) && child === parent.update))
  )
    return (
      (t.isForStatement(parent) && child === parent.update
        ? webSocketUpdateSuspension(parent.body, state)
        : undefined) ??
      (parent.test == null
        ? undefined
        : webSocketCompletedSuspension(parent.test, state)) ??
      (t.isForStatement(parent) && parent.init != null
        ? webSocketCompletedSuspension(parent.init, state)
        : undefined)
    );
  const byParent = webSocketSuspensionFacts(state).prefixes;
  let prefixes = byParent.get(parent);
  if (prefixes === undefined) {
    const indexed = new Map<t.Node, WebSocketSuspension>();
    let awaited: WebSocketSuspension | undefined;
    // Reaching any call argument proves that optional short-circuiting did not
    // skip this call's argument list. Index earlier arguments once for reads
    // inside the list, without making them mandatory for code after the call.
    const operands =
      (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
      javaScriptOptionalOperandsMayBeSkipped(parent)
        ? [parent.callee, ...parent.arguments]
        : webSocketOrderedEvaluation(parent, state);
    for (const node of operands) {
      if (awaited !== undefined) indexed.set(node, awaited);
      if (
        syntaxEvaluationAlwaysThrows(node) ||
        (t.isForOfStatement(node) &&
          semanticIteratorAcquisitionAlwaysFails(node.right, state))
      )
        break;
      awaited = webSocketCompletedSuspension(node, state) ?? awaited;
    }
    byParent.set(parent, indexed);
    prefixes = indexed;
  }
  return prefixes.get(child);
};

/** Find a completed suspension on the containing straight-line evaluation path. */
const webSocketContinuation = (
  node: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  let current = node;
  while (current !== body) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return undefined;
    const awaited = webSocketPrecedingSuspension(parent, current, state);
    if (awaited !== undefined) return awaited;
    current = parent;
  }
  return undefined;
};

/** A class owns instance field initialization and its constructor activation. */
const webSocketMemberClass = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Class | undefined => {
  const body = state.parentsByNode.get(node);
  const declaration =
    body === undefined ? undefined : state.parentsByNode.get(body);
  return t.isClass(declaration) ? declaration : undefined;
};

/** Find the class construction that evaluates a field or constructor. */
const webSocketClassConstruction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  calls: ReadonlyMap<
    t.Function | t.Class,
    JavaScriptSemanticAnalysisState["callSites"][number]
  > = new Map(),
): t.NewExpression | undefined => {
  const declaration = webSocketMemberClass(node, state);
  if (declaration === undefined) return undefined;
  const invocation =
    calls.get(declaration) ?? webSocketImmediateInvocation(declaration, state);
  if (t.isNewExpression(invocation)) return invocation;

  const implicitlyConstructs = (
    derived: t.Class,
    capture: t.NewExpression,
    seen: Set<t.Class> = new Set(),
  ): boolean => {
    if (derived === declaration) return true;
    if (
      seen.has(derived) ||
      derived.superClass == null ||
      derived.body.body.some(
        (member) => t.isClassMethod(member) && member.kind === "constructor",
      )
    )
      return false;
    seen.add(derived);
    state.memberMutationFactsPhase ??= "requested";
    // Construction proof depends on the alias-aware prototype mutation index.
    // Preserve the field conservatively while discovery requests that index;
    // the final pass will decide from the completed effects.
    if (state.memberMutationFactsPhase !== "indexed") return false;
    const bindings = new Set<
      NonNullable<ReturnType<typeof resolveSemanticBindingState>>
    >();
    if (derived.id != null) {
      const binding = resolveSemanticBindingState(
        state,
        derived.id,
        derived.id.name,
      );
      if (binding !== undefined) bindings.add(binding);
    }
    for (const { read } of semanticExactValueIdentity(derived, state)
      ?.aliases ?? []) {
      const binding = resolveSemanticBindingState(state, read, read.name);
      if (binding !== undefined) bindings.add(binding);
    }
    // A class's inner self binding and its outer declaration binding select
    // one allocation. Prototype effects belong to that shared identity.
    const prototypeEffects = [
      ...(state.literalMemberEffects?.get(derived) ?? []),
      ...[...bindings].flatMap((binding) => [
        ...binding.memberWrites,
        ...binding.escapedPaths,
      ]),
    ];
    if (
      prototypeEffects.some(
        ({ path, node }) =>
          semanticPrototypeLookupMayChange(path, "__proto__") &&
          semanticEffectTiming(capture, node, state) !== "after",
      )
    )
      return false;
    const bases = semanticClassCandidates(derived.superClass, state);
    return (
      bases.length === 1 &&
      bases[0] !== undefined &&
      implicitlyConstructs(bases[0], capture, seen)
    );
  };
  const constructions = new Set<t.NewExpression>();
  for (const [activation, call] of calls)
    if (
      t.isClass(activation) &&
      t.isNewExpression(call) &&
      implicitlyConstructs(activation, call)
    )
      constructions.add(call);
  for (const call of state.callSites) {
    if (!t.isNewExpression(call)) continue;
    for (const candidate of semanticClassCandidates(call.callee, state))
      if (
        implicitlyConstructs(candidate, call) &&
        webSocketImmediateInvocation(candidate, state) === call
      )
        constructions.add(call);
  }
  return constructions.size === 1 ? [...constructions][0] : undefined;
};

/** Legacy decorator application follows its class's keys and static values. */
const webSocketDecoratedClass = (
  node: t.Decorator,
  state: JavaScriptSemanticAnalysisState,
): t.Class | undefined => {
  let parent = state.parentsByNode.get(node);
  while (parent !== undefined) {
    if (t.isClass(parent)) return parent;
    if (
      t.isProgram(parent) ||
      (t.isFunction(parent) &&
        !t.isClassMethod(parent) &&
        !t.isClassPrivateMethod(parent))
    )
      return undefined;
    parent = state.parentsByNode.get(parent);
  }
  return undefined;
};

interface WebSocketParameterResume {
  readonly parameter: t.ArrayPattern;
  readonly invocation:
    | t.CallExpression
    | t.OptionalCallExpression
    | t.NewExpression
    | t.AssignmentExpression;
}

/** Select a potential reached callee without imposing completed-write validity. */
const webSocketSelectedCallee = (raw: t.Node): t.Node => {
  let node = unwrapJavaScriptExpression(raw).node;
  for (;;) {
    const selected = javaScriptExactResultOperand(
      node,
      () => true,
      syntaxEvaluationCannotThrow,
    );
    if (selected === undefined) return node;
    node = unwrapJavaScriptExpression(selected).node;
  }
};

/** Reuse body activation ownership, caching only each requested callee subtree. */
const webSocketImmediateCaller = (
  call: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Function | undefined => {
  const callers = webSocketExecutionFacts(state).immediateCallers;
  const cached = callers.get(call);
  if (cached !== undefined) return cached ?? undefined;
  if (
    !t.isCallExpression(call) &&
    !t.isOptionalCallExpression(call) &&
    !t.isNewExpression(call) &&
    !t.isAssignmentExpression(call)
  )
    return undefined;
  const pending: t.Node[] = [
    t.isAssignmentExpression(call) ? call.left : call.callee,
  ];
  if (!t.isAssignmentExpression(call)) {
    const target = webSocketStoredCallTarget(
      call.callee,
      state,
      call,
      noCallbackParameters,
    );
    if (t.isFunction(target)) {
      callers.set(call, target);
      return target;
    }
  }
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    // A nested call result cannot identify its own caller from functions in
    // its receiver or arguments. Exact returned-callable cases were handled
    // by webSocketStoredCallTarget above. Pruning this subtree is important
    // for chains such as `promise.then(...).then(...)`: otherwise each outer
    // call rescans every earlier receiver and callback.
    if (node !== call && t.isNewExpression(node)) {
      // A fresh literal class receiver still owns its selected method/setter.
      // Its constructor arguments cannot identify the outer invocation.
      const selected = webSocketSelectedCallee(node.callee);
      if (t.isClass(selected)) pending.push(selected);
      continue;
    }
    if (
      node !== call &&
      (t.isCallExpression(node) ||
        t.isOptionalCallExpression(node) ||
        t.isNewExpression(node))
    )
      continue;
    if (t.isFunction(node)) {
      const invocation: ReturnType<typeof webSocketImmediateInvocation> =
        t.isClassMethod(node) && node.kind === "constructor"
          ? webSocketClassConstruction(node, state)
          : webSocketImmediateInvocation(node, state);
      if (
        invocation === call ||
        (t.isAssignmentExpression(call) &&
          (t.isObjectMethod(node) || t.isClassMethod(node)) &&
          node.kind === "set" &&
          invocation !== undefined &&
          semanticValueWriteSite(invocation, state.parentsByNode) === call)
      ) {
        callers.set(call, node);
        return node;
      }
    }
    pending.push(...childNodes(node));
  }
  callers.set(call, null);
  return undefined;
};

/** Match a known literal invocation's positional argument, never an unknown spread offset. */
const webSocketArgumentParameter = (
  result: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | {
      readonly parameter: t.Node;
      readonly invocation: WebSocketParameterResume["invocation"];
    }
  | undefined => {
  const parent = state.parentsByNode.get(result);
  if (
    t.isAssignmentExpression(parent) &&
    parent.operator === "=" &&
    parent.right === result
  ) {
    const owner = webSocketImmediateCaller(parent, state);
    const parameter =
      owner === undefined ? undefined : runtimeFunctionParameters(owner)[0];
    const pattern = t.isAssignmentPattern(parameter)
      ? parameter.left
      : parameter;
    return pattern !== undefined
      ? { parameter: pattern, invocation: parent }
      : undefined;
  }
  const array = t.isArrayExpression(parent) ? parent : undefined;
  const call = array === undefined ? parent : state.parentsByNode.get(array);
  if (
    !t.isCallExpression(call) &&
    !t.isOptionalCallExpression(call) &&
    !t.isNewExpression(call)
  )
    return undefined;
  let callee = webSocketSelectedCallee(call.callee);
  const owner = webSocketImmediateCaller(call, state);
  if (owner === undefined) return undefined;
  const classBody = state.parentsByNode.get(owner);
  const literalClass = t.isClassBody(classBody)
    ? state.parentsByNode.get(classBody)
    : undefined;
  const value =
    t.isClassMethod(owner) &&
    owner.kind === "constructor" &&
    t.isClassExpression(literalClass)
      ? webSocketOuterExpression(literalClass, state)
      : webSocketOuterExpression(owner, state);
  const selection = webSocketFreshMethodSelection(owner, value, state);
  const callable = webSocketSelectedCallee(
    selection === undefined
      ? value
      : webSocketOuterExpression(selection, state),
  );
  let offset = 0;
  if (
    callee !== callable &&
    (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee))
  ) {
    const method = semanticStaticPropertyName(callee.property, callee.computed);
    if (method !== "call" && method !== "apply") return undefined;
    if (
      method === "apply"
        ? array === undefined || call.arguments[1] !== array
        : array !== undefined
    )
      return undefined;
    offset = method === "call" ? 1 : 0;
    callee = webSocketSelectedCallee(callee.object);
  } else if (array !== undefined) return undefined;
  // Bound argument lists need a separate positional proof; the activation alone
  // does not say which parameter receives this generator.
  if (callee !== callable) {
    const exact = semanticExactValueIdentity(callee, state);
    // Direct stored aliases preserve positional arguments; a bound result
    // does not, since its saved arguments need a separate offset proof.
    if (exact?.node !== owner || !webSocketAliasesInitialized(exact, state))
      return undefined;
  }
  const arguments_ = array?.elements ?? call.arguments;
  const index = arguments_.indexOf(result as t.Expression);
  if (
    index < offset ||
    arguments_.slice(0, index).some((argument) => t.isSpreadElement(argument))
  )
    return undefined;
  const parameter = runtimeFunctionParameters(owner)[index - offset];
  const pattern = t.isAssignmentPattern(parameter) ? parameter.left : parameter;
  return pattern !== undefined
    ? { parameter: pattern, invocation: call }
    : undefined;
};

const webSocketParameterResume = (
  result: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketParameterResume | undefined => {
  const selected = webSocketArgumentParameter(result, state);
  return selected !== undefined &&
    t.isArrayPattern(selected.parameter) &&
    selected.parameter.elements.length > 0
    ? { parameter: selected.parameter, invocation: selected.invocation }
    : undefined;
};

const generatorPatternConsumers = new WeakMap<
  JavaScriptSemanticAnalysisState,
  Map<
    string,
    { readonly pattern: t.ArrayPattern; readonly read: t.Identifier } | null
  >
>();

/** Resolve an iterator's one immutable stored consumer without guessing among aliases. */
const webSocketSinglePatternConsumer = (
  bindingId: string,
  state: JavaScriptSemanticAnalysisState,
):
  | { readonly pattern: t.ArrayPattern; readonly read: t.Identifier }
  | undefined => {
  let cached = generatorPatternConsumers.get(state);
  if (cached === undefined) {
    cached = new Map();
    const reads = new Map<string, t.Identifier | null>();
    const pending: t.Node[] = [state.program];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) break;
      if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        const parent = state.parentsByNode.get(node);
        if (
          binding !== undefined &&
          !(t.isVariableDeclarator(parent) && parent.id === node)
        )
          reads.set(
            binding.bindingId,
            reads.has(binding.bindingId) ? null : node,
          );
      }
      pending.push(...childNodes(node));
    }
    for (const [id, read] of reads) {
      const parent = read === null ? undefined : state.parentsByNode.get(read);
      cached.set(
        id,
        read !== null &&
          t.isVariableDeclarator(parent) &&
          parent.init === read &&
          t.isArrayPattern(parent.id)
          ? { pattern: parent.id, read }
          : null,
      );
    }
    generatorPatternConsumers.set(state, cached);
  }
  return cached.get(bindingId) ?? undefined;
};

/** Direct iteration, literal parameters and iterable spreads resume a fresh generator in-turn. */
const webSocketGeneratorResume = (
  invocation: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | t.CallExpression
  | t.OptionalCallExpression
  | t.ForOfStatement
  | t.SpreadElement
  | t.ArrayPattern
  | t.YieldExpression
  | WebSocketParameterResume
  | { readonly pattern: t.ArrayPattern; readonly read: t.Identifier }
  | undefined => {
  const result = webSocketOuterExpression(invocation, state, true);
  const member = state.parentsByNode.get(result);
  if (t.isForOfStatement(member) && member.right === result) return member;
  if (
    t.isYieldExpression(member) &&
    member.delegate &&
    member.argument === result
  )
    return member;
  const pattern =
    t.isVariableDeclarator(member) && member.init === result
      ? member.id
      : t.isAssignmentExpression(member) &&
          member.right === result &&
          member.operator === "="
        ? member.left
        : undefined;
  if (t.isArrayPattern(pattern) && pattern.elements.length > 0) return pattern;
  if (
    t.isVariableDeclarator(member) &&
    member.init === result &&
    t.isIdentifier(member.id)
  ) {
    const binding = resolveSemanticBindingState(
      state,
      member.id,
      member.id.name,
    );
    if (
      binding !== undefined &&
      !binding.mutable &&
      binding.initializers.length === 1 &&
      binding.referenceInitializers.length === 0
    ) {
      const consumer = webSocketSinglePatternConsumer(binding.bindingId, state);
      if (
        consumer !== undefined &&
        consumer.pattern.elements.length > 0 &&
        semanticInitializerPrecedesRead({
          initializer: result,
          read: consumer.read,
          bindingNode: member.id,
          parents: state.parentsByNode,
          initializerContexts: webSocketExecutionContexts(result, state),
          readContexts: webSocketExecutionContexts(consumer.read, state),
        }) === true
      )
        return consumer;
    }
  }
  const parameter = webSocketParameterResume(result, state);
  if (parameter !== undefined) return parameter;
  if (t.isSpreadElement(member) && member.argument === result) {
    const consumer = state.parentsByNode.get(member);
    if (
      t.isArrayExpression(consumer) ||
      t.isCallExpression(consumer) ||
      t.isOptionalCallExpression(consumer) ||
      t.isNewExpression(consumer)
    )
      return member;
  }
  if (
    (!t.isMemberExpression(member) && !t.isOptionalMemberExpression(member)) ||
    member.object !== result ||
    semanticStaticPropertyName(member.property, member.computed) !== "next"
  )
    return undefined;
  const callee = webSocketOuterExpression(member, state);
  const call = state.parentsByNode.get(callee);
  return (t.isCallExpression(call) || t.isOptionalCallExpression(call)) &&
    call.callee === callee
    ? call
    : undefined;
};

/** A synchronous iterator resumes in-turn unless its consumer body can await. */
const webSocketBodyMaySuspend = (
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean | undefined => {
  const cache = webSocketExecutionFacts(state).bodySuspensions;
  const known = cache.get(body);
  if (known !== undefined) return known.value;
  const remember = (value: boolean | undefined): boolean | undefined => {
    cache.set(body, { value });
    return value;
  };
  const pending = [body];
  let maySuspend = false;
  let unknownResource = false;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (t.isCatchClause(node)) {
      const binding = webSocketCatchBinding(node, state);
      maySuspend ||= binding?.suspension !== undefined;
      if (
        binding !== undefined &&
        binding.phase !== "completed" &&
        binding.phase !== "suspended"
      )
        continue;
      pending.push(node.body);
      continue;
    }
    if (
      (t.isAwaitExpression(node) &&
        !syntaxEvaluationAlwaysThrows(node.argument)) ||
      (t.isYieldExpression(node) &&
        (node.argument == null ||
          !syntaxEvaluationAlwaysThrows(node.argument))) ||
      (t.isForOfStatement(node) &&
        node.await &&
        !semanticIteratorAcquisitionAlwaysFails(node.right, state))
    ) {
      maySuspend = true;
    }
    if (t.isVariableDeclaration(node) && node.kind === "await using") {
      const { disposal } = semanticAsyncDeclarationFacts(node, state);
      maySuspend ||= disposal === "wait";
      unknownResource ||= disposal === "unknown";
    }
    if (
      t.isForOfStatement(node) &&
      semanticIteratorAcquisitionAlwaysFails(node.right, state)
    ) {
      pending.push(node.right);
      continue;
    }
    pending.push(...syntaxReachableOperands(node));
  }
  // An uncertain acquisition does not erase an independently reachable wait.
  // If acquisition fails there is no next step; if it completes, that wait remains.
  return remember(maySuspend ? true : unknownResource ? undefined : false);
};

/** Possible waits and waits required by every continuation are different facts. */
const webSocketConsumerAlwaysWaits = (
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
  exits: "iteration" | "scope",
): boolean =>
  !syntaxMayCompleteWithoutBoundary(
    body,
    (node, phase) => {
      if (phase === "iteration" && t.isForOfStatement(node)) {
        state.memberMutationFactsPhase ??= "requested";
        if (state.memberMutationFactsPhase !== "indexed") return undefined;
        if (semanticIteratorAcquisitionAlwaysFails(node.right, state))
          return "throw";
        // Unknown iterator hooks can fail synchronously and enter a catch
        // without waiting. Native array acquisition has no such hook here.
        const iterable = semanticExactValueIdentity(node.right, state);
        return iterable !== undefined &&
          t.isArrayExpression(iterable.node) &&
          webSocketAliasesInitialized(iterable, state) &&
          semanticLiteralOwnKeysStable(iterable.node, node, state) &&
          semanticKnownArrayIterationAt(node.right, state) &&
          semanticExpressionCannotThrow(node.right, state, (read) =>
            webSocketExecutionContexts(read, state),
          )
          ? "suspension"
          : undefined;
      }
      if (
        (t.isAwaitExpression(node) &&
          (exits === "scope"
            ? syntaxEvaluationCannotThrow(node.argument)
            : !syntaxEvaluationAlwaysThrows(node.argument))) ||
        (t.isYieldExpression(node) &&
          (node.argument == null || syntaxEvaluationCannotThrow(node.argument)))
      )
        return "suspension";
      if (
        t.isBlockStatement(node) &&
        webSocketEveryExitSuspension(node, state) !== undefined
      )
        return "suspension";
      if (t.isCatchClause(node)) {
        const binding = webSocketCatchBinding(node, state);
        if (binding?.suspension !== undefined) return "suspension";
        if (binding !== undefined && binding.phase !== "completed")
          return "throw";
      }
      if (
        t.isVariableDeclarator(node) &&
        node.init != null &&
        !t.isIdentifier(node.id)
      ) {
        const binding = webSocketBindingCompletion(node.id, node.init, state);
        if (
          syntaxEvaluationCannotThrow(node.init) &&
          binding.phase === "suspended"
        )
          return "suspension";
        if (binding.phase === "blocked") return "throw";
      }
      return undefined;
    },
    exits,
    (node) => {
      if (
        exits !== "iteration" ||
        !(
          (t.isOptionalCallExpression(node) && node.optional) ||
          (t.isOptionalMemberExpression(node) && node.optional && node.computed)
        )
      )
        return undefined;
      const receiver = t.isOptionalCallExpression(node)
        ? node.callee
        : node.object;
      // Only a proven initialized bare binding can omit the receiver read.
      // The remaining operands still complete left-to-right through try/catch.
      if (!t.isIdentifier(receiver)) return undefined;
      const exact = semanticExactValueIdentity(receiver, state);
      if (
        exact === undefined ||
        !(
          t.isFunction(exact.node) ||
          t.isObjectExpression(exact.node) ||
          t.isArrayExpression(exact.node) ||
          t.isClassExpression(exact.node)
        ) ||
        !webSocketAliasesInitialized(exact, state)
      )
        return undefined;
      return t.isOptionalCallExpression(node)
        ? node.arguments
        : [node.property];
    },
    (node) =>
      semanticExpressionCannotThrow(node, state, (read) =>
        webSocketExecutionContexts(read, state),
      ),
  );

type WebSocketConsumerPhase =
  | "same-turn"
  | "after-wait"
  | "unknown"
  | "unknown-resource"
  | "unreachable";

/** A delegated generator inherits the surrounding generator's actual consumer phase. */
const webSocketGeneratorConsumerPhase = (
  invocation: t.Node,
  read: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
  ownedResultEscape?: t.Node,
  seen = new Set<t.Node>(),
): WebSocketConsumerPhase => {
  if (seen.has(invocation)) return "unknown";
  seen.add(invocation);
  if (t.isSpreadElement(invocation)) return "same-turn";
  if (t.isArrayPattern(invocation)) {
    const completion = semanticPatternCompletionBeforeGeneratorRead({
      executionFrames: (node) => webSocketExecutionContexts(node, state, true),
      read,
      body,
      pattern: invocation,
      state,
      ...(ownedResultEscape === undefined ? {} : { ownedResultEscape }),
      ordered: (node) => webSocketOrderedEvaluation(node, state),
      maySuspend: (node) => webSocketBodyMaySuspend(node, state) !== false,
      completedSuspension: (node) =>
        webSocketCompletedSuspension(node, state) !== undefined,
    });
    return completion === "blocked" || completion === "suspended-blocked"
      ? "unreachable"
      : completion === "suspended"
        ? "after-wait"
        : "same-turn";
  }
  if (t.isForOfStatement(invocation)) {
    const cleanup = semanticGeneratorReadInCleanup(
      read,
      body,
      state,
      (node) => webSocketOrderedEvaluation(node, state),
      (node) => webSocketBodyMaySuspend(node, state) !== false,
    );
    if (!cleanup && !syntaxMayReachNextIteration(invocation.body))
      return "same-turn";
    if (invocation.await) return "after-wait";
    const left = webSocketBodyMaySuspend(invocation.left, state);
    const possible = webSocketBodyMaySuspend(invocation.body, state);
    const pattern = t.isVariableDeclaration(invocation.left)
      ? invocation.left.declarations[0]?.id
      : invocation.left;
    const bindingPhase =
      pattern === undefined
        ? "completed"
        : semanticGeneratorBindingPhase(
            read,
            body,
            pattern,
            state,
            (node) => webSocketOrderedEvaluation(node, state),
            (node) => webSocketBodyMaySuspend(node, state) !== false,
            (pattern, value) =>
              webSocketBindingCompletion(
                pattern,
                value,
                state,
                ownedResultEscape,
                !cleanup,
              ).phase,
          );
    if (bindingPhase === "blocked" || bindingPhase === "suspended-blocked")
      return cleanup && bindingPhase === "suspended-blocked"
        ? "after-wait"
        : "same-turn";
    if (
      bindingPhase === "suspended" ||
      bindingPhase === "suspended-unproven" ||
      (possible === true &&
        webSocketConsumerAlwaysWaits(
          invocation.body,
          state,
          cleanup ? "scope" : "iteration",
        ))
    )
      return "after-wait";
    if (left !== false || possible !== false) return "unknown-resource";
    return "same-turn";
  }
  if (t.isYieldExpression(invocation) && invocation.delegate) {
    const owner = webSocketSuspensionOwner(invocation, state);
    if (
      !t.isFunction(owner) ||
      t.isArrowFunctionExpression(owner) ||
      !owner.generator ||
      owner.async
    )
      return "unknown";
    const call = webSocketImmediateInvocation(owner, state);
    const resume =
      call === undefined ? undefined : webSocketGeneratorResume(call, state);
    return resume === undefined
      ? "unknown"
      : webSocketGeneratorConsumerPhase(
          "parameter" in resume
            ? resume.parameter
            : "pattern" in resume
              ? resume.pattern
              : resume,
          read,
          owner.body,
          state,
          call,
          seen,
        );
  }
  return "unknown";
};

/** The lexical body that actually suspends owns the continuation boundary. */
const webSocketSuspensionOwner = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Node => {
  let current: t.Node = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return current;
    if (
      t.isFunction(parent) &&
      !(
        (t.isClassMethod(parent) || t.isObjectMethod(parent)) &&
        parent.key === current
      )
    )
      return parent;
    current = parent;
  }
};

/** A caller directly awaiting this result cannot initialize later locals yet. */
const webSocketWaitingContexts = (
  invocation: t.Node,
  state: JavaScriptSemanticAnalysisState,
): readonly SemanticExecutionFrame[] => {
  const contexts: SemanticExecutionFrame[] = [];
  const pending = [invocation];
  const seen = new Set<t.Node>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const awaited of semanticAwaitedResultSites(current, state, (node) =>
      webSocketExecutionContexts(node, state, true),
    )) {
      const owner = webSocketSuspensionOwner(awaited, state);
      contexts.push({ owner, point: awaited });
      if (t.isFunction(owner)) {
        const caller = webSocketImmediateInvocation(owner, state);
        if (caller !== undefined) pending.push(caller);
      }
    }
  }
  return contexts;
};

/** A failed lexical read can reach a later binding only through owned recovery. */
const webSocketReadFailureCanRecover = (
  initializer: SemanticExecutionFrame,
  read: SemanticExecutionFrame,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  // Repeated lexical owners need activation pairing, not cross-activation
  // source ordering. Only the single program activation proves this recovery.
  if (initializer.owner !== state.program || read.owner !== state.program)
    return false;
  let child = read.point;
  for (;;) {
    const parent = state.parentsByNode.get(child);
    if (parent === undefined || t.isFunction(parent) || t.isLoop(parent))
      return false;
    if (
      t.isTryStatement(parent) &&
      parent.block === child &&
      parent.handler != null &&
      (parent.handler.param == null || t.isIdentifier(parent.handler.param)) &&
      syntaxEvaluationCannotThrow(parent.handler.body) &&
      (parent.finalizer == null ||
        syntaxEvaluationCannotThrow(parent.finalizer))
    ) {
      const body = state.parentsByNode.get(parent);
      if (!t.isProgram(body) && !t.isBlockStatement(body)) return false;
      let following = initializer.point;
      while (state.parentsByNode.get(following) !== body) {
        const ancestor = state.parentsByNode.get(following);
        if (ancestor === undefined || t.isFunction(ancestor)) return false;
        following = ancestor;
      }
      const before = body.body.indexOf(parent);
      const after = body.body.indexOf(following as t.Statement);
      return (
        before >= 0 &&
        after > before &&
        body.body.slice(before + 1, after).every(syntaxEvaluationCannotThrow)
      );
    }
    child = parent;
    if (child === state.program) return false;
  }
};

/** A lexical switch initializer is not reached by entering another case. */
export const webSocketInitializerDominatesRead = (
  initializer: t.Node,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  bindingNode?: t.Node,
): boolean => {
  return (
    semanticInitializerPrecedesRead({
      initializer,
      read,
      ...(bindingNode === undefined ? {} : { bindingNode }),
      parents: state.parentsByNode,
      initializerContexts: webSocketExecutionContexts(initializer, state),
      readContexts: webSocketExecutionContexts(read, state),
      readFailureCanRecover: (before, after) =>
        webSocketReadFailureCanRecover(before, after, state),
    }) ?? true
  );
};

/** Index class evaluation once; all keys precede every static initializer. */
const webSocketClassPrefix = (
  member: t.Node,
  computedKey: boolean,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  const body = state.parentsByNode.get(member);
  const declaration =
    body === undefined ? undefined : state.parentsByNode.get(body);
  if (!t.isClass(declaration)) return undefined;
  const byClass = webSocketExecutionFacts(state).classPrefixes;
  let prefixes = byClass.get(declaration);
  if (prefixes === undefined) {
    const keys = new Map<t.Node, WebSocketSuspension | null>();
    const statics = new Map<t.Node, WebSocketSuspension | null>();
    let suspended: WebSocketSuspension | undefined;
    let failed = false;
    const advance = (operand: t.Node): void => {
      if (failed) return;
      if (syntaxEvaluationAlwaysThrows(operand)) {
        failed = true;
        suspended = undefined;
      } else
        suspended = webSocketCompletedSuspension(operand, state) ?? suspended;
    };
    if (declaration.superClass != null) advance(declaration.superClass);
    for (const item of declaration.body.body) {
      if (failed) break;
      keys.set(item, suspended ?? null);
      if (
        (javaScriptClassField(item) || t.isClassMethod(item)) &&
        "computed" in item &&
        item.computed
      )
        advance(item.key);
    }
    for (const item of declaration.body.body) {
      if (failed) break;
      statics.set(item, suspended ?? null);
      for (const initializer of syntaxStaticInitializers(item))
        advance(initializer);
    }
    prefixes = { keys, statics };
    byClass.set(declaration, prefixes);
  }
  return (
    (computedKey ? prefixes.keys : prefixes.statics).get(member) ?? undefined
  );
};

/**
 * Keep local initialization ordered across suspension phases. A suspension cuts
 * off outer execution frames only after retaining the body that owns it. Calls
 * evaluate callee/arguments before bodies; classes evaluate keys, static values,
 * and construction arguments before instance fields and constructor bodies.
 */
export const webSocketExecutionContexts = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  directOnly = false,
): readonly SemanticExecutionFrame[] =>
  webSocketExecutionContextsForCalls(
    node,
    state,
    directOnly,
    new Map(),
    new Map(),
  );

interface WebSocketActivationPrefix {
  readonly current: t.Node;
  readonly point: t.Node;
  readonly suspendedOwner: t.Node | undefined;
}

const webSocketStoredCallMatches = (
  stored: WebSocketStoredCall,
  calls: ReadonlyMap<t.Function | t.Class, WebSocketCallSite>,
): boolean =>
  stored.activation === undefined ||
  calls.get(stored.activation.owner) === undefined ||
  calls.get(stored.activation.owner) === stored.activation.call;

const webSocketStoredCallContexts = (
  stored: WebSocketStoredCall,
  activation: t.Function | t.Class,
  calls: ReadonlyMap<t.Function | t.Class, WebSocketCallSite>,
): ReadonlyMap<t.Function | t.Class, WebSocketCallSite> | undefined => {
  const selected = new Map(calls);
  if (stored.activation !== undefined) {
    const existing = selected.get(stored.activation.owner);
    if (existing !== undefined && existing !== stored.activation.call)
      return undefined;
    selected.set(stored.activation.owner, stored.activation.call);
  }
  selected.set(activation, stored.call);
  return selected;
};

/** Retain every visible activation rather than treating repetition as a TDZ. */
const webSocketExecutionContextsForCalls = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  directOnly: boolean,
  calls: ReadonlyMap<
    t.Function | t.Class,
    JavaScriptSemanticAnalysisState["callSites"][number]
  >,
  expanded: Map<t.Function | t.Class, WebSocketActivationPrefix[]>,
): readonly SemanticExecutionFrame[] => {
  let selectedCalls = calls;
  const contexts: SemanticExecutionFrame[] = [];
  let point = node;
  let suspendedOwner: t.Node | undefined;
  const suspendedAt = (suspension: WebSocketSuspension | undefined): void => {
    if (suspension !== undefined)
      suspendedOwner = webSocketSuspensionOwner(suspension, state);
  };
  const suspendedAfter = (evaluated: t.Node): void =>
    suspendedAt(webSocketCompletedSuspension(evaluated, state));
  let current = node;
  const activations = new Set<t.Function | t.Class>();
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return [...contexts, { owner: current, point }];
    const instanceClass =
      (javaScriptClassField(parent) &&
        !parent.static &&
        parent.value === current) ||
      (t.isClassMethod(parent) &&
        parent.kind === "constructor" &&
        parent.body === current)
        ? webSocketMemberClass(parent, state)
        : undefined;
    const activation =
      instanceClass ??
      (t.isFunction(parent) &&
      !(
        (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
        parent.key === current
      )
        ? parent
        : undefined);
    if (activation !== undefined) {
      if (activations.has(activation)) return contexts;
      activations.add(activation);
      const allStored = webSocketStoredCalls(activation, state);
      const stored = allStored.filter((candidate) =>
        webSocketStoredCallMatches(candidate, selectedCalls),
      );
      if (allStored.length > 0 && stored.length === 0) return [];
      if (stored.length > 1 && !selectedCalls.has(activation)) {
        // Join identical prefixes rather than expanding a Cartesian history.
        const prefixes = expanded.get(activation) ?? [];
        if (
          prefixes.some(
            (prefix) =>
              prefix.current === current &&
              prefix.point === point &&
              prefix.suspendedOwner === suspendedOwner,
          )
        )
          return [...contexts, { owner: activation, point }];
        prefixes.push({ current, point, suspendedOwner });
        expanded.set(activation, prefixes);
        return stored.flatMap((candidate) => {
          const next = webSocketStoredCallContexts(
            candidate,
            activation,
            selectedCalls,
          );
          return next === undefined
            ? []
            : webSocketExecutionContextsForCalls(
                node,
                state,
                directOnly,
                next,
                expanded,
              );
        });
      }
      if (stored.length === 1 && !selectedCalls.has(activation)) {
        const only = stored[0];
        if (only === undefined) return [];
        const next = webSocketStoredCallContexts(
          only,
          activation,
          selectedCalls,
        );
        if (next === undefined) return [];
        selectedCalls = next;
      }
    }
    if (javaScriptClassField(parent) && parent.value === current) {
      if (parent.static)
        suspendedAt(webSocketClassPrefix(parent, false, state));
      else {
        const construction = webSocketClassConstruction(
          parent,
          state,
          selectedCalls,
        );
        if (construction === undefined)
          return [...contexts, { owner: parent, point }];
        suspendedAfter(construction);
        if (instanceClass !== undefined)
          contexts.push({ owner: instanceClass, point });
        point = construction;
        current = construction;
        continue;
      }
    }
    if (
      (javaScriptClassField(parent) || t.isClassMethod(parent)) &&
      "computed" in parent &&
      parent.computed &&
      parent.key === current
    )
      suspendedAt(webSocketClassPrefix(parent, true, state));
    if (t.isStaticBlock(parent))
      suspendedAt(webSocketClassPrefix(parent, false, state));
    if (t.isFunction(parent)) {
      if (
        (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
        parent.key === current
      ) {
        current = parent;
        continue;
      }
      let invocation:
        | ReturnType<typeof webSocketImmediateInvocation>
        | t.ForOfStatement
        | t.SpreadElement
        | t.ArrayPattern
        | t.AssignmentExpression
        | t.YieldExpression =
        t.isClassMethod(parent) && parent.kind === "constructor"
          ? webSocketClassConstruction(parent, state, selectedCalls)
          : (selectedCalls.get(parent) ??
            webSocketImmediateInvocation(parent, state));
      const nativePromiseExecutor =
        t.isFunction(parent) && parent.async
          ? semanticNativePromiseExecutor(
              parent,
              webSocketOuterExpression(parent, state),
              state,
            )
          : undefined;
      contexts.push({ owner: parent, point });
      const generatorBody =
        current === parent.body &&
        !t.isArrowFunctionExpression(parent) &&
        parent.generator;
      const generatorInvocation = invocation;
      let parameterConsumer: t.ArrayPattern | undefined;
      let storedConsumerRead: t.Identifier | undefined;
      if (
        generatorBody &&
        invocation !== undefined &&
        !t.isNewExpression(invocation)
      ) {
        const resume = webSocketGeneratorResume(invocation, state);
        storedConsumerRead =
          resume !== undefined && "pattern" in resume ? resume.read : undefined;
        parameterConsumer =
          resume !== undefined && "parameter" in resume
            ? resume.parameter
            : undefined;
        invocation =
          resume !== undefined && "parameter" in resume
            ? resume.invocation
            : resume !== undefined && "pattern" in resume
              ? resume.pattern
              : resume;
      }
      if (invocation === undefined) return contexts;
      if (
        generatorBody &&
        (!semanticEvaluationMayBeReached(
          generatorInvocation ?? invocation,
          state,
        ) ||
          !semanticEvaluationMayBeReached(
            storedConsumerRead ?? invocation,
            state,
          ))
      )
        return [];
      const decoratedClass = t.isDecorator(invocation)
        ? webSocketDecoratedClass(invocation, state)
        : undefined;
      if (t.isOptionalCallExpression(invocation)) {
        // Reaching this literal body proves the optional call was taken.
        // Its argument evaluation therefore precedes body entry.
        for (const operand of [invocation.callee, ...invocation.arguments])
          suspendedAfter(operand);
      } else if (
        (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
        parent.kind === "set"
      ) {
        const site = semanticValueWriteSite(invocation, state.parentsByNode);
        if (site !== undefined) {
          // RHS and preceding pattern slots finish before the selected write,
          // whereas later slots must not defer this setter activation.
          const structuredPattern =
            t.isAssignmentExpression(site) &&
            (t.isObjectPattern(site.left) || t.isArrayPattern(site.left));
          if (!structuredPattern)
            suspendedAt(webSocketContinuation(invocation, site, state));
          if (t.isAssignmentExpression(site)) {
            if (!structuredPattern) suspendedAfter(site.right);
            if (
              semanticPatternSuspendsBeforeTarget(
                site.left,
                site.right,
                invocation,
                state,
                (operand) =>
                  webSocketCompletedSuspension(operand, state) !== undefined,
                (node) => webSocketExecutionContexts(node, state, true),
              )
            )
              suspendedOwner = webSocketSuspensionOwner(site, state);
          }
          if (t.isForOfStatement(site) && site.await) suspendedAt(site);
          if (!structuredPattern) suspendedAfter(invocation);
          else invocation = site;
        }
      } else if (
        t.isObjectMethod(parent) &&
        parent.kind === "get" &&
        (t.isObjectProperty(invocation) || t.isRestElement(invocation))
      ) {
        // A pattern key finishes before Get, while defaults and nested binding
        // work in the value occur only after the getter has returned.
        const pattern = state.parentsByNode.get(invocation);
        const consumer =
          pattern === undefined ? undefined : state.parentsByNode.get(pattern);
        const value = t.isVariableDeclarator(consumer)
          ? consumer.init
          : t.isAssignmentExpression(consumer)
            ? consumer.right
            : undefined;
        if (t.isObjectPattern(pattern) && value != null) {
          const phase = semanticPatternCompletionBeforeTarget(
            pattern,
            value,
            invocation,
            state,
            (operand) =>
              webSocketCompletedSuspension(operand, state) !== undefined,
            (node) => webSocketExecutionContexts(node, state, true),
          );
          if (phase === "suspended" || phase === "suspended-unproven")
            suspendedOwner = webSocketSuspensionOwner(invocation, state);
          else if (phase === "unproven") return contexts;
        }
      } else if (!t.isArrayPattern(invocation)) {
        suspendedAfter(
          t.isForOfStatement(invocation)
            ? invocation.right
            : t.isYieldExpression(invocation)
              ? (invocation.argument ?? invocation)
              : (decoratedClass ?? invocation),
        );
      }
      const consumerPhase =
        generatorBody && !parent.async
          ? webSocketGeneratorConsumerPhase(
              parameterConsumer ?? invocation,
              node,
              parent.body,
              state,
              generatorInvocation,
            )
          : "unknown";
      if (consumerPhase === "unreachable") return [];
      if (
        // Unknown consumer acquisition is not evidence that a synchronous
        // yield let the surrounding caller initialize later locals.
        (parent.async || generatorBody) &&
        current === parent.body &&
        consumerPhase !== "same-turn" &&
        consumerPhase !== "unknown-resource"
      ) {
        if (
          consumerPhase === "after-wait" &&
          semanticGeneratorReadAfterYield(
            node,
            parent.body,
            state,
            (node) => webSocketOrderedEvaluation(node, state),
            (node) => webSocketBodyMaySuspend(node, state) !== false,
          )
        )
          suspendedOwner = parent;
        else if (consumerPhase === "after-wait" && t.isArrayPattern(invocation))
          // Before the first iterator step, the consumer's target reference
          // suspends its own activation, not the unstarted generator body.
          suspendedOwner = webSocketSuspensionOwner(invocation, state);
        const continuation = webSocketContinuation(point, parent.body, state);
        if (continuation !== undefined)
          suspendedOwner = webSocketSuspensionOwner(continuation, state);
      }
      // Direct frames are an earlier invocation bound for alias initialization.
      // They do not consult the waiting index that is currently being built.
      if (suspendedOwner === parent && !directOnly)
        // The executor's returned promise is ignored. An outer wait constrains
        // this read only while both settlement capabilities remain unavailable
        // until after the read; an earlier call or escape preserves uncertainty.
        return nativePromiseExecutor === invocation &&
          !webSocketExecutorSettlesAfterRead(parent, node, state)
          ? contexts
          : [...contexts, ...webSocketWaitingContexts(invocation, state)];
      point = storedConsumerRead ?? invocation;
      if (storedConsumerRead !== undefined) {
        current = storedConsumerRead;
        continue;
      }
      // A returned callable executes outside its producer's completed activation.
      if (
        webSocketReturnedOwner(parent, state) !== undefined ||
        webSocketStoredCalls(parent, state).some(
          ({ call }) => call === invocation,
        )
      ) {
        current = invocation;
        continue;
      }
      // Method/parameter decorator metadata is evaluated with the class, not
      // within the decorated method's runtime activation.
      if (decoratedClass !== undefined) {
        current = decoratedClass;
        continue;
      }
    }
    current = parent;
  }
};
