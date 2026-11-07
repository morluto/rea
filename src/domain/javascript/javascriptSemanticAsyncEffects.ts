import * as t from "@babel/types";

import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticCallable,
  JavaScriptSemanticProjectedResultBinding,
  JavaScriptSemanticEventOperation,
  JavaScriptSemanticTimerOperation,
} from "./javascriptSemanticIr.js";
import { createSemanticCallableIdStack } from "./javascriptSemanticCallableStack.js";
import {
  isNullishJavaScriptSyntax,
  readExactJavaScriptLiteral,
  semanticStaticPropertyName,
  staticJavaScriptTruthiness,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { SEMANTIC_EXPRESSION_DEPTH_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  semanticBindingAtRead,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import { traverseJavaScriptValueAst } from "./javascriptSemanticTraversal.js";
import { evaluateSemanticProvenance } from "./javascriptSemanticValues.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import {
  semanticBindingMayHaveOpaqueEffect,
  semanticOpaqueBindingReadMayHaveChanged,
  semanticOpaqueNameMayHaveChanged,
} from "./javascriptSemanticOpaqueEffects.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import { semanticKnownArrayIterationAt } from "./javascriptSemanticReferenceSources.js";
import {
  semanticGlobalProcessOrigin,
  semanticGlobalProcessPathOrigin,
  semanticRequireOrigin,
} from "./javascriptSemanticRequireOrigin.js";
import {
  builtinDataEffectMethod,
  builtinChildProcessMethod,
  dataEffectArgumentBindingId,
  dataEffectLiteralString,
  dataEffectMemberCallee,
  assignedSemanticResultBindings,
  scalarAssignedResultBinding,
  semanticProjectedBindingFacts,
} from "./javascriptSemanticDataEffectHelpers.js";

const EVENT_REGISTER_METHODS = [
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
] as const;
const EVENT_REMOVE_METHODS = [
  "off",
  "removeListener",
  "removeAllListeners",
] as const;
/**
 * Methods whose argument position 1 names a listener. `removeAllListeners`
 * takes only an optional event name, and `emit` passes its remaining
 * arguments as data to listeners that already exist.
 */
const EVENT_LISTENER_METHODS: readonly JavaScriptSemanticEventOperation["method"][] =
  [...EVENT_REGISTER_METHODS, "off", "removeListener"];
const EVENT_METHODS = [
  ...EVENT_REGISTER_METHODS,
  ...EVENT_REMOVE_METHODS,
  "emit",
] as const;
const TIMER_SCHEDULE_METHODS = [
  "setTimeout",
  "setInterval",
  "setImmediate",
] as const;
const TIMER_CANCEL_METHODS = [
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
] as const;

/**
 * Node keeps two timer handle families. `clearTimeout` and `clearInterval` are
 * aliases that act only on a `Timeout` from `setTimeout` or `setInterval`, and
 * `clearImmediate` acts only on an `Immediate` from `setImmediate`. Clearing
 * within a family always cancels. Clearing across the families is
 * runtime-dependent: `setImmediate` then `clearTimeout`/`clearInterval` never
 * cancels, but `setTimeout` then `clearImmediate` reports as cancelled on some
 * supported Node versions and fires on others. The analysis therefore treats a
 * cross-family clear as unresolved rather than as proof that the timer kept
 * running.
 */
const timerHandleFamily = (
  method: JavaScriptSemanticTimerOperation["method"],
): "timeout" | "immediate" =>
  method === "setImmediate" || method === "clearImmediate"
    ? "immediate"
    : "timeout";

interface AsyncEffectAnalysis {
  readonly eventOperations: readonly JavaScriptSemanticEventOperation[];
  readonly timerOperations: readonly JavaScriptSemanticTimerOperation[];
}

interface TimerCandidate {
  readonly node: t.CallExpression | t.OptionalCallExpression;
  readonly method: JavaScriptSemanticTimerOperation["method"];
  readonly kind: JavaScriptSemanticTimerOperation["kind"];
  readonly ownerCallableId: string | null;
  readonly handleBindingId: string | null;
  readonly projectedResultBindings: readonly JavaScriptSemanticProjectedResultBinding[];
  readonly handleRead: {
    readonly origins: readonly t.Node[];
    readonly complete: boolean;
  } | null;
}

interface TimerCollectionInput {
  readonly node: t.CallExpression | t.OptionalCallExpression;
  readonly ownerCallableId: string | null;
  readonly state: JavaScriptSemanticAnalysisState;
  readonly output: TimerCandidate[];
  readonly ancestors: readonly t.Node[];
}

/** Recover explicit EventEmitter and Node timer candidates from inert syntax. */
export const collectJavaScriptSemanticAsyncEffects = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
  callables: readonly JavaScriptSemanticCallable[],
): AsyncEffectAnalysis => {
  const events: JavaScriptSemanticEventOperation[] = [];
  const timers: TimerCandidate[] = [];
  const callableIds = new Set(callables.map(({ callableId }) => callableId));
  const callableStack = createSemanticCallableIdStack(callableIds);
  const ancestors: t.Node[] = [];
  traverseJavaScriptValueAst(program, state.erasedSyntaxNodes, {
    enter: (node, parent) => {
      callableStack.enter(node, parent);
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const ownerCallableId = callableStack.callables.at(-1) ?? null;
        collectEvent(node, ownerCallableId, state, events);
        collectTimer({
          node,
          ownerCallableId,
          state,
          output: timers,
          ancestors,
        });
      }
      ancestors.push(node);
    },
    exit: (node) => {
      ancestors.pop();
      callableStack.exit(node);
    },
  });
  return {
    eventOperations: events,
    timerOperations: resolveTimers(timers),
  };
};

/** Determine truthiness from syntax or simple unary/constant expressions. */
const staticExpressionTruthiness = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  initialDepth = 0,
): boolean | undefined => {
  let current: t.Node = node;
  let inverted = false;
  let depth = initialDepth;

  while (depth <= SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
    const unwrapped = unwrapJavaScriptExpression(current).node;
    if (t.isUnaryExpression(unwrapped) && unwrapped.operator === "!") {
      inverted = !inverted;
      current = unwrapped.argument;
      depth++;
      continue;
    }
    const direct = staticJavaScriptTruthiness(unwrapped);
    if (direct !== undefined) return inverted ? !direct : direct;
    if (t.isRegExpLiteral(unwrapped) || t.isClassExpression(unwrapped))
      return !inverted;
    if (t.isTemplateLiteral(unwrapped)) {
      if (
        unwrapped.quasis.some(
          (q) =>
            typeof q.value.cooked === "string" && q.value.cooked.length > 0,
        )
      ) {
        return !inverted;
      }
      if (
        unwrapped.expressions.length === 0 &&
        unwrapped.quasis.every((q) => q.value.cooked === "")
      ) {
        return inverted;
      }
    }
    if (t.isUnaryExpression(unwrapped)) {
      if (unwrapped.operator === "void") return inverted;
      if (unwrapped.operator === "typeof") return !inverted;
      if (
        (unwrapped.operator === "+" || unwrapped.operator === "-") &&
        t.isNumericLiteral(unwrapped.argument)
      ) {
        const val =
          unwrapped.argument.value !== 0 &&
          !Number.isNaN(unwrapped.argument.value);
        return inverted ? !val : val;
      }
    }
    if (
      t.isIdentifier(unwrapped) &&
      isUnmodifiedGlobalReference(unwrapped, state, unwrapped.name) &&
      !semanticOpaqueNameMayHaveChanged(unwrapped, state)
    ) {
      if (unwrapped.name === "undefined" || unwrapped.name === "NaN")
        return inverted;
      if (unwrapped.name === "Infinity") return !inverted;
    }
    return undefined;
  }

  state.valueResourceLimits.add("expression-depth");
  return undefined;
};

/** Determine whether syntax definitely evaluates to null or undefined. */
const staticExpressionNullishness = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean | undefined => {
  const unwrapped = unwrapJavaScriptExpression(node).node;
  if (t.isNullLiteral(unwrapped) || isNullishJavaScriptSyntax(unwrapped))
    return true;
  if (t.isUnaryExpression(unwrapped)) {
    if (unwrapped.operator === "void") return true;
    if (["+", "-", "~", "!", "typeof", "delete"].includes(unwrapped.operator))
      return false;
  }
  if (
    t.isIdentifier(unwrapped, { name: "undefined" }) &&
    isUnmodifiedGlobalReference(unwrapped, state, "undefined") &&
    !semanticOpaqueNameMayHaveChanged(unwrapped, state)
  )
    return true;
  if (
    t.isIdentifier(unwrapped) &&
    ["NaN", "Infinity"].includes(unwrapped.name) &&
    isUnmodifiedGlobalReference(unwrapped, state, unwrapped.name) &&
    !semanticOpaqueNameMayHaveChanged(unwrapped, state)
  )
    return false;
  if (
    t.isBooleanLiteral(unwrapped) ||
    t.isNumericLiteral(unwrapped) ||
    t.isStringLiteral(unwrapped) ||
    t.isBigIntLiteral(unwrapped) ||
    t.isArrayExpression(unwrapped) ||
    t.isObjectExpression(unwrapped) ||
    t.isFunctionExpression(unwrapped) ||
    t.isArrowFunctionExpression(unwrapped) ||
    t.isClassExpression(unwrapped) ||
    t.isRegExpLiteral(unwrapped) ||
    t.isTemplateLiteral(unwrapped) ||
    t.isImportExpression(unwrapped)
  )
    return false;
  return undefined;
};

/**
 * Flatten statically known array spreads to locate the argument occupying
 * parameter position `targetIndex`.
 */
export function* flattenCallArguments(
  args: readonly (
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
  )[],
  depth = 0,
  state?: JavaScriptSemanticAnalysisState,
): Generator<
  | t.Expression
  | t.SpreadElement
  | t.JSXNamespacedName
  | t.ArgumentPlaceholder
  | undefined
> {
  for (const arg of args) {
    if (t.isSpreadElement(arg)) {
      if (depth >= SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
        state?.valueResourceLimits.add("expression-depth");
        yield arg;
        continue;
      }
      const unwrapped = unwrapJavaScriptExpression(arg.argument);
      const nextDepth = depth + unwrapped.depth + 1;
      if (nextDepth > SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
        state?.valueResourceLimits.add("expression-depth");
        yield arg;
        continue;
      }
      const inner = unwrapped.node;
      if (t.isArrayExpression(inner)) {
        if (
          state !== undefined &&
          !semanticKnownArrayIterationAt(inner, state)
        ) {
          yield arg;
          continue;
        }
        for (const element of inner.elements) {
          if (element === null) {
            yield undefined;
          } else if (t.isSpreadElement(element)) {
            yield* flattenCallArguments([element], nextDepth, state);
          } else {
            yield element;
          }
        }
        continue;
      }
    }
    yield arg;
  }
}

export const resolvePositionalArgument = (
  args: readonly (
    | t.Expression
    | t.SpreadElement
    | t.JSXNamespacedName
    | t.ArgumentPlaceholder
  )[],
  targetIndex: number,
  state?: JavaScriptSemanticAnalysisState,
):
  | t.Expression
  | t.SpreadElement
  | t.JSXNamespacedName
  | t.ArgumentPlaceholder
  | undefined => {
  let index = 0;
  for (const arg of flattenCallArguments(args, 0, state)) {
    if (index === targetIndex) return arg;
    if (t.isSpreadElement(arg)) {
      // An unexpanded dynamic spread shifts all subsequent argument positions unpredictably.
      return arg;
    }
    index += 1;
  }
  return undefined;
};

/**
 * A listener must be a function, and Node throws `ERR_INVALID_ARG_TYPE` before
 * anything is registered or removed when it is omitted or is a value that can
 * never be a function. An identifier, a call result, a class expression or a
 * spread may still supply a callable at runtime and keeps its operation.
 */
export const rejectsEventListener = (
  listener: t.Node | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (listener === undefined) return true;
  const pending: {
    readonly node: t.Node | undefined;
    readonly depth: number;
  }[] = [{ node: listener, depth: 0 }];
  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    if (current.node === undefined) continue;
    if (t.isSpreadElement(current.node)) {
      if (current.depth >= SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
        state.valueResourceLimits.add("expression-depth");
        return false;
      }
      const unwrappedArg = unwrapJavaScriptExpression(current.node.argument);
      const nextDepth = current.depth + unwrappedArg.depth + 1;
      if (nextDepth > SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
        state.valueResourceLimits.add("expression-depth");
        return false;
      }
      if (t.isArrayExpression(unwrappedArg.node)) {
        if (!semanticKnownArrayIterationAt(unwrappedArg.node, state)) {
          return false;
        }
        const flattened = [
          ...flattenCallArguments([current.node], current.depth, state),
        ];
        if (flattened.length === 0) {
          // An empty array spread (...[] or ...[...[]]) supplies no listener.
          continue;
        }
        const first = flattened[0];
        if (first === undefined) {
          continue;
        }
        if (t.isSpreadElement(first)) {
          return false;
        }
        if (t.isExpression(first)) {
          pending.push({ node: first, depth: nextDepth });
          continue;
        }
      }
      return false;
    }
    const unwrapped = unwrapJavaScriptExpression(current.node);
    const depth = current.depth + unwrapped.depth;
    if (depth > SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
      state.valueResourceLimits.add("expression-depth");
      return false;
    }
    const value = unwrapped.node;
    if (t.isConditionalExpression(value)) {
      const truthiness = staticExpressionTruthiness(value.test, state, depth);
      if (truthiness === true) {
        pending.push({ node: value.consequent, depth: depth + 1 });
      } else if (truthiness === false) {
        pending.push({ node: value.alternate, depth: depth + 1 });
      } else {
        pending.push(
          { node: value.consequent, depth: depth + 1 },
          { node: value.alternate, depth: depth + 1 },
        );
      }
      continue;
    }
    if (t.isLogicalExpression(value)) {
      if (value.operator === "||") {
        const truthiness = staticExpressionTruthiness(value.left, state, depth);
        if (truthiness === true) {
          pending.push({ node: value.left, depth: depth + 1 });
        } else if (truthiness === false) {
          pending.push({ node: value.right, depth: depth + 1 });
        } else {
          pending.push(
            { node: value.left, depth: depth + 1 },
            { node: value.right, depth: depth + 1 },
          );
        }
        continue;
      }
      if (value.operator === "&&") {
        const truthiness = staticExpressionTruthiness(value.left, state, depth);
        if (truthiness === false) {
          // A falsy value in JavaScript can never be a callable function.
          continue;
        }
        pending.push({ node: value.right, depth: depth + 1 });
        continue;
      }
      if (value.operator === "??") {
        const nullishness = staticExpressionNullishness(value.left, state);
        if (nullishness === false) {
          pending.push({ node: value.left, depth: depth + 1 });
        } else if (nullishness === true) {
          pending.push({ node: value.right, depth: depth + 1 });
        } else {
          pending.push(
            { node: value.left, depth: depth + 1 },
            { node: value.right, depth: depth + 1 },
          );
        }
        continue;
      }
      continue;
    }
    if (t.isSequenceExpression(value)) {
      pending.push({ node: value.expressions.at(-1), depth: depth + 1 });
      continue;
    }
    if (t.isAssignmentExpression(value)) {
      if (value.operator === "=") {
        pending.push({ node: value.right, depth: depth + 1 });
        continue;
      }
      if (value.operator === "||=") {
        const truthiness = staticExpressionTruthiness(value.left, state, depth);
        if (truthiness === true) {
          pending.push({ node: value.left, depth: depth + 1 });
        } else if (truthiness === false) {
          pending.push({ node: value.right, depth: depth + 1 });
        } else {
          pending.push(
            { node: value.left, depth: depth + 1 },
            { node: value.right, depth: depth + 1 },
          );
        }
        continue;
      }
      if (value.operator === "&&=") {
        const truthiness = staticExpressionTruthiness(value.left, state, depth);
        if (truthiness === false) {
          continue;
        }
        pending.push({ node: value.right, depth: depth + 1 });
        continue;
      }
      if (value.operator === "??=") {
        const nullishness = staticExpressionNullishness(value.left, state);
        if (nullishness === false) {
          pending.push({ node: value.left, depth: depth + 1 });
        } else if (nullishness === true) {
          pending.push({ node: value.right, depth: depth + 1 });
        } else {
          pending.push(
            { node: value.left, depth: depth + 1 },
            { node: value.right, depth: depth + 1 },
          );
        }
        continue;
      }
      continue;
    }
    if (
      t.isFunctionExpression(value) ||
      t.isArrowFunctionExpression(value) ||
      t.isClassExpression(value)
    )
      return false;
    // A numeric literal is always a number, including the non-finite value Babel
    // stores for `1e999`, which the exact-value reader refuses to price.
    if (t.isNumericLiteral(value)) continue;
    if (
      t.isIdentifier(value) &&
      ["undefined", "NaN", "Infinity"].includes(value.name) &&
      isUnmodifiedGlobalReference(value, state, value.name) &&
      !semanticOpaqueNameMayHaveChanged(value, state)
    )
      continue;
    // Every unary, non-pipeline binary or update operator yields a primitive,
    // and a primitive is never callable.
    if (
      t.isUnaryExpression(value) ||
      (t.isBinaryExpression(value) && value.operator !== "|>") ||
      t.isUpdateExpression(value) ||
      readExactJavaScriptLiteral(value).found ||
      t.isTemplateLiteral(value) ||
      t.isBigIntLiteral(value) ||
      t.isRegExpLiteral(value) ||
      t.isArrayExpression(value) ||
      t.isObjectExpression(value) ||
      t.isImportExpression(value)
    )
      continue;
    return false;
  }
  return true;
};

const isProcessModuleOrigin = (origin: JavaScriptModuleOrigin): boolean => {
  const specifier = origin.specifier.replace(/^node:/u, "");
  return (
    specifier === "process" &&
    (origin.importedPath.length === 0 ||
      (origin.importedPath.length === 1 &&
        origin.importedPath[0] === "default"))
  );
};

interface RelevantListenerOverrideBinding {
  readonly binding: JavaScriptSemanticBindingState;
  readonly isClass: boolean;
  readonly isNamespace: boolean;
  readonly hasMemberOverride: boolean;
}

interface RelevantModuleEffects {
  readonly hasWriteOverride: boolean;
  readonly escapeNodes: readonly t.Node[];
}

interface RelevantListenerOverrideIndex {
  readonly child_process: readonly RelevantListenerOverrideBinding[];
  readonly events: readonly RelevantListenerOverrideBinding[];
  readonly process: readonly RelevantListenerOverrideBinding[];
  readonly moduleEffects: {
    readonly child_process: RelevantModuleEffects;
    readonly events: RelevantModuleEffects;
    readonly process: RelevantModuleEffects;
  };
  readonly ambientProcessWrites: readonly t.Node[];
  readonly ambientProcessEscapes: readonly t.Node[];
}

const listenerOverrideIndexByState = new WeakMap<
  JavaScriptSemanticAnalysisState,
  RelevantListenerOverrideIndex
>();

const getListenerOverrideIndex = (
  state: JavaScriptSemanticAnalysisState,
): RelevantListenerOverrideIndex => {
  const existing = listenerOverrideIndexByState.get(state);
  if (existing !== undefined) return existing;

  const childProcessBindings: RelevantListenerOverrideBinding[] = [];
  const eventsBindings: RelevantListenerOverrideBinding[] = [];
  const processBindings: RelevantListenerOverrideBinding[] = [];

  for (const binding of state.bindingsById.values()) {
    if (binding.memberWrites.length === 0 && binding.escapedPaths.length === 0)
      continue;
    const provenance = evaluateSemanticProvenance(binding, state);
    if (provenance.status !== "module") continue;
    for (const origin of provenance.origins) {
      const specifier = origin.specifier.replace(/^node:/u, "");
      if (specifier === "child_process") {
        const isClass = origin.importedPath[0] === "ChildProcess";
        const isNamespace = origin.importedPath.length === 0;
        const hasMemberOverride = binding.memberWrites.some(({ path }) =>
          path.some(
            (segment) => segment === "prototype" || segment === "ChildProcess",
          ),
        );
        childProcessBindings.push({
          binding,
          isClass,
          isNamespace,
          hasMemberOverride,
        });
      } else if (specifier === "events") {
        const isClass = origin.importedPath[0] === "EventEmitter";
        const isNamespace =
          origin.importedPath.length === 0 ||
          (origin.importedPath.length === 1 &&
            origin.importedPath[0] === "default");
        const hasMemberOverride = binding.memberWrites.some(({ path }) =>
          path.some(
            (segment) => segment === "prototype" || segment === "EventEmitter",
          ),
        );
        eventsBindings.push({
          binding,
          isClass,
          isNamespace,
          hasMemberOverride,
        });
      } else if (specifier === "process") {
        const isNamespace =
          origin.importedPath.length === 0 ||
          (origin.importedPath.length === 1 &&
            origin.importedPath[0] === "default");
        const hasMemberOverride = binding.memberWrites.some(({ path }) =>
          path.some(
            (segment) =>
              segment === "prototype" ||
              EVENT_LISTENER_METHODS.includes(
                segment as (typeof EVENT_LISTENER_METHODS)[number],
              ),
          ),
        );
        processBindings.push({
          binding,
          isClass: false,
          isNamespace,
          hasMemberOverride,
        });
      }
    }
  }

  let cpHasWrite = false;
  const cpEscapes: t.Node[] = [];
  let eventsHasWrite = false;
  const eventsEscapes: t.Node[] = [];
  let processHasWrite = false;
  const processEscapes: t.Node[] = [];

  for (const [specifier, effects] of state.requiredModuleEffects.entries()) {
    const raw = specifier.replace(/^node:/u, "");
    if (raw === "child_process") {
      for (const { kind, path, node } of effects) {
        if (
          kind === "write" &&
          path.some((s) => s === "prototype" || s === "ChildProcess")
        ) {
          cpHasWrite = true;
        } else if (
          kind === "escape" &&
          (path.length === 0 ||
            path.some((s) => s === "prototype" || s === "ChildProcess"))
        ) {
          if (node !== undefined) cpEscapes.push(node);
        }
      }
    } else if (raw === "events") {
      for (const { kind, path, node } of effects) {
        if (
          kind === "write" &&
          path.some((s) => s === "prototype" || s === "EventEmitter")
        ) {
          eventsHasWrite = true;
        } else if (
          kind === "escape" &&
          (path.length === 0 ||
            path.some((s) => s === "prototype" || s === "EventEmitter"))
        ) {
          if (node !== undefined) eventsEscapes.push(node);
        }
      }
    } else if (raw === "process") {
      for (const { kind, path, node } of effects) {
        if (
          kind === "write" &&
          (path.length === 0 ||
            path.some(
              (s) =>
                s === "prototype" ||
                EVENT_LISTENER_METHODS.includes(
                  s as (typeof EVENT_LISTENER_METHODS)[number],
                ),
            ))
        ) {
          processHasWrite = true;
        } else if (
          kind === "escape" &&
          (path.length === 0 ||
            path.some(
              (s) =>
                s === "prototype" ||
                EVENT_LISTENER_METHODS.includes(
                  s as (typeof EVENT_LISTENER_METHODS)[number],
                ),
            ))
        ) {
          if (node !== undefined) processEscapes.push(node);
        }
      }
    }
  }

  const isProcessEffectPath = (
    path: JavaScriptSemanticAnalysisState["ambientWriteEffects"][number]["path"],
  ): boolean =>
    (path[0] === "process" &&
      (path.length <= 1 ||
        (typeof path[1] === "string" &&
          EVENT_LISTENER_METHODS.includes(
            path[1] as (typeof EVENT_LISTENER_METHODS)[number],
          )))) ||
    (path[0] === "global" &&
      path[1] === "process" &&
      (path.length <= 2 ||
        (typeof path[2] === "string" &&
          EVENT_LISTENER_METHODS.includes(
            path[2] as (typeof EVENT_LISTENER_METHODS)[number],
          ))));

  const ambientProcessWrites: t.Node[] = [];
  for (const { path, node } of state.ambientWriteEffects) {
    if (node !== undefined && isProcessEffectPath(path)) {
      ambientProcessWrites.push(node);
    }
  }
  const ambientProcessEscapes: t.Node[] = [];
  for (const { path, node } of state.ambientEscapeEffects) {
    if (node !== undefined && isProcessEffectPath(path)) {
      ambientProcessEscapes.push(node);
    }
  }

  const index: RelevantListenerOverrideIndex = {
    child_process: childProcessBindings,
    events: eventsBindings,
    process: processBindings,
    moduleEffects: {
      child_process: {
        hasWriteOverride: cpHasWrite,
        escapeNodes: cpEscapes,
      },
      events: {
        hasWriteOverride: eventsHasWrite,
        escapeNodes: eventsEscapes,
      },
      process: {
        hasWriteOverride: processHasWrite,
        escapeNodes: processEscapes,
      },
    },
    ambientProcessWrites,
    ambientProcessEscapes,
  };
  listenerOverrideIndexByState.set(state, index);
  return index;
};

const hasRelevantBindingOverride = (
  entries: readonly RelevantListenerOverrideBinding[],
  call?: t.Node,
): boolean => {
  for (const entry of entries) {
    if (
      entry.isClass ||
      entry.hasMemberOverride ||
      (entry.isNamespace &&
        entry.binding.escapedPaths.some(
          (effect) => call === undefined || effect.node !== call,
        ))
    ) {
      return true;
    }
  }
  return false;
};

const checkModuleEffects = (
  effects: RelevantModuleEffects,
  call?: t.Node,
): boolean =>
  effects.hasWriteOverride ||
  effects.escapeNodes.some((node) => call === undefined || node !== call);

/** Check whether prototype, module, or escape effects may have changed Node's listener methods. */
const hasInheritedListenerMethodOverride = (
  state: JavaScriptSemanticAnalysisState,
  target: "child_process" | "events" | "process",
  call?: t.Node,
): boolean => {
  const index = getListenerOverrideIndex(state);
  if (target === "child_process") {
    if (
      hasRelevantBindingOverride(index.child_process, call) ||
      hasRelevantBindingOverride(index.events, call) ||
      checkModuleEffects(index.moduleEffects.child_process, call) ||
      checkModuleEffects(index.moduleEffects.events, call)
    ) {
      return true;
    }
  } else if (target === "events") {
    if (
      hasRelevantBindingOverride(index.events, call) ||
      checkModuleEffects(index.moduleEffects.events, call)
    ) {
      return true;
    }
  } else if (target === "process") {
    if (
      hasRelevantBindingOverride(index.process, call) ||
      hasRelevantBindingOverride(index.events, call) ||
      checkModuleEffects(index.moduleEffects.process, call) ||
      checkModuleEffects(index.moduleEffects.events, call) ||
      index.ambientProcessWrites.some(
        (node) => call === undefined || node !== call,
      ) ||
      index.ambientProcessEscapes.some(
        (node) => call === undefined || node !== call,
      )
    ) {
      return true;
    }
  }
  if (target === "child_process") {
    if (
      state.ambientEscapes.covers(["child_process"]) ||
      state.ambientEscapes.covers(["node:child_process"]) ||
      state.ambientWrites.covers(["child_process"]) ||
      state.ambientWrites.covers(["node:child_process"])
    )
      return true;
  }
  if (
    target === "events" ||
    target === "child_process" ||
    target === "process"
  ) {
    if (
      state.ambientEscapes.covers(["events"]) ||
      state.ambientEscapes.covers(["node:events"]) ||
      state.ambientWrites.covers(["events"]) ||
      state.ambientWrites.covers(["node:events"])
    )
      return true;
  }
  if (target === "process") {
    if (
      state.ambientEscapes.covers(["process"]) ||
      state.ambientEscapes.covers(["global", "process"]) ||
      state.ambientWrites.covers(["process"]) ||
      state.ambientWrites.covers(["global", "process"])
    )
      return true;
  }
  return false;
};

/** Check whether an expression is a proven native child process or EventEmitter creation. */
const isProvenCreationNode = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  escapeLimitNode?: t.Node,
): boolean => {
  const unwrapped = unwrapJavaScriptExpression(node).node;
  if (t.isCallExpression(unwrapped) || t.isOptionalCallExpression(unwrapped)) {
    return (
      builtinChildProcessMethod(unwrapped.callee, state) !== null &&
      !hasInheritedListenerMethodOverride(
        state,
        "child_process",
        escapeLimitNode,
      )
    );
  }
  if (!t.isNewExpression(unwrapped)) return false;
  const constructor = unwrapped.callee;
  if (t.isIdentifier(constructor)) {
    const owner = resolveSemanticBindingState(
      state,
      constructor,
      constructor.name,
    );
    if (
      owner === undefined ||
      owner.memberWrites.length > 0 ||
      owner.escapedPaths.some(
        (effect) =>
          escapeLimitNode !== undefined && effect.node !== escapeLimitNode,
      )
    )
      return false;
  } else if (
    t.isMemberExpression(constructor) &&
    t.isIdentifier(constructor.object)
  ) {
    const owner = resolveSemanticBindingState(
      state,
      constructor.object,
      constructor.object.name,
    );
    if (
      owner === undefined ||
      owner.escapedPaths.some(
        (effect) =>
          escapeLimitNode !== undefined && effect.node !== escapeLimitNode,
      ) ||
      owner.memberWrites.some(({ path }) =>
        path.some(
          (segment) => segment === "prototype" || segment === "EventEmitter",
        ),
      )
    )
      return false;
  }
  return (
    builtinDataEffectMethod(constructor, state, ["events", "node:events"]) ===
      "EventEmitter" &&
    !hasInheritedListenerMethodOverride(state, "events", escapeLimitNode)
  );
};

/** Identify stable Node-owned emitter instances without inferring generic APIs. */
export const isProvenNodeEmitter = (
  receiver: t.Expression | t.Super,
  call: t.CallExpression | t.OptionalCallExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let currentReceiver: t.Expression | t.Super = receiver;
  const visitedBindings = new Set<string>();

  for (let depth = 0; depth <= SEMANTIC_EXPRESSION_DEPTH_LIMIT; depth++) {
    const unwrapped = unwrapJavaScriptExpression(currentReceiver).node;
    if (
      t.isCallExpression(unwrapped) ||
      t.isOptionalCallExpression(unwrapped) ||
      t.isNewExpression(unwrapped)
    ) {
      const requireOrigin = semanticRequireOrigin(unwrapped, state);
      if (
        requireOrigin !== undefined &&
        isProcessModuleOrigin(requireOrigin.origin)
      ) {
        return !hasInheritedListenerMethodOverride(state, "process", call);
      }
      return isProvenCreationNode(unwrapped, state, unwrapped);
    }
    if (
      (t.isIdentifier(unwrapped) &&
        semanticGlobalProcessOrigin(unwrapped, state) !== undefined) ||
      (t.isMemberExpression(unwrapped) &&
        semanticGlobalProcessPathOrigin(unwrapped, state)?.importedPath
          .length === 0)
    ) {
      return !hasInheritedListenerMethodOverride(state, "process", call);
    }
    if (!t.isIdentifier(unwrapped)) return false;
    const binding = resolveSemanticBindingState(
      state,
      unwrapped,
      unwrapped.name,
    );
    if (binding === undefined || visitedBindings.has(binding.bindingId))
      return false;
    visitedBindings.add(binding.bindingId);
    if (
      binding.mutable &&
      semanticOpaqueBindingReadMayHaveChanged(binding, unwrapped, state)
    )
      return false;
    if (
      semanticBindingMayHaveOpaqueEffect(binding, state, unwrapped, "reference")
    )
      return false;
    const activeBinding = binding.mutable
      ? (() => {
          const read = semanticBindingAtRead(binding, unwrapped, state);
          return read.status === "ordered" && read.hasDefiniteInitializer
            ? read.binding
            : undefined;
        })()
      : binding;
    if (activeBinding === undefined) return false;
    if (
      activeBinding.memberWrites.some(
        ({ node }) =>
          !semanticTopLevelEffectFollowsCapture(
            call,
            node,
            state.parentsByNode,
          ),
      ) ||
      activeBinding.escapedPaths.some(
        (effect) =>
          effect.node !== call &&
          !semanticTopLevelEffectFollowsCapture(
            call,
            effect.node,
            state.parentsByNode,
          ),
      )
    )
      return false;

    const isImportedProcess = activeBinding.directOrigins.some(
      isProcessModuleOrigin,
    );
    const isReachableProcessModule =
      isImportedProcess ||
      (() => {
        const provenance = evaluateSemanticProvenance(activeBinding, state);
        return (
          provenance.status === "module" &&
          provenance.origins.length === 1 &&
          isProcessModuleOrigin(provenance.origins[0])
        );
      })();

    if (isReachableProcessModule) {
      return !hasInheritedListenerMethodOverride(state, "process", call);
    }

    const initializers = [
      ...activeBinding.initializers,
      ...activeBinding.referenceInitializers,
    ];
    if (initializers.length !== 1 || initializers[0]?.projection.length !== 0)
      return false;
    const initNode = initializers[0].node;
    if (
      (t.isIdentifier(initNode) &&
        semanticGlobalProcessOrigin(initNode, state) !== undefined) ||
      (t.isMemberExpression(initNode) &&
        semanticGlobalProcessPathOrigin(initNode, state)?.importedPath
          .length === 0)
    ) {
      return !hasInheritedListenerMethodOverride(state, "process", call);
    }
    if (t.isIdentifier(initNode)) {
      currentReceiver = initNode;
      continue;
    }
    return isProvenCreationNode(initNode, state, initNode);
  }

  return false;
};

const collectEvent = (
  node: t.CallExpression | t.OptionalCallExpression,
  ownerCallableId: string | null,
  state: JavaScriptSemanticAnalysisState,
  output: JavaScriptSemanticEventOperation[],
): void => {
  const member = dataEffectMemberCallee(node);
  if (member === null) return;
  const method = EVENT_METHODS.find(
    (candidate) =>
      candidate ===
      semanticStaticPropertyName(member.property, member.computed),
  );
  if (method === undefined) return;
  const kind = eventKind(method);
  const eventArgument = resolvePositionalArgument(node.arguments, 0, state);
  const listenerMethod = EVENT_LISTENER_METHODS.includes(method);
  const listenerArgument = listenerMethod
    ? resolvePositionalArgument(node.arguments, 1, state)
    : undefined;
  // A dynamic or unexpanded spread shifts the runtime argument positions or leaves
  // the callback uncertain; only reject when both arguments were resolved.
  const invalidNodeListener =
    listenerMethod &&
    !t.isSpreadElement(eventArgument) &&
    !t.isSpreadElement(listenerArgument) &&
    rejectsEventListener(listenerArgument, state);
  if (invalidNodeListener && isProvenNodeEmitter(member.object, node, state))
    return;
  const emitter = emitterIdentity(member.object, state);
  const eventName = dataEffectLiteralString(eventArgument);
  output.push({
    eventId: `event:${kind}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
    kind,
    method,
    location: range(node),
    ownerCallableId,
    emitterKey: emitter.key,
    emitterBindingId: emitter.bindingId,
    eventName,
    listenerBindingId: dataEffectArgumentBindingId(listenerArgument, state),
    listenerLocation: t.isNode(listenerArgument)
      ? range(listenerArgument)
      : null,
    resolution:
      eventName === null
        ? "unresolved"
        : emitter.complete && !invalidNodeListener
          ? "complete"
          : "partial",
  });
};

const eventKind = (
  method: JavaScriptSemanticEventOperation["method"],
): JavaScriptSemanticEventOperation["kind"] => {
  if (EVENT_REGISTER_METHODS.some((candidate) => candidate === method))
    return "register";
  if (EVENT_REMOVE_METHODS.some((candidate) => candidate === method))
    return "remove";
  return "dispatch";
};

const emitterIdentity = (
  node: t.Expression | t.Super,
  state: JavaScriptSemanticAnalysisState,
): {
  readonly key: string;
  readonly bindingId: string | null;
  readonly complete: boolean;
} => {
  if (t.isIdentifier(node)) {
    const binding = resolveSemanticBindingState(state, node, node.name);
    if (binding !== undefined) {
      const read = semanticBindingAtRead(binding, node, state);
      const origins = [
        ...read.binding.initializers,
        ...read.binding.referenceInitializers,
      ];
      const replaced = binding.definitions.some(
        ({ kind }) => kind === "assignment",
      );
      const origin = origins.length === 1 ? origins[0] : undefined;
      const complete =
        !replaced ||
        (read.status === "ordered" &&
          read.hasDefiniteInitializer &&
          origin !== undefined);
      return {
        key: !replaced
          ? `binding:${binding.bindingId}`
          : complete
            ? `binding:${binding.bindingId}:origin:${origin?.node.start ?? -1}:${origin?.node.end ?? -1}`
            : `expression:${node.start ?? -1}:${node.end ?? -1}`,
        bindingId: binding.bindingId,
        complete,
      };
    }
    return {
      key: `global:${node.name}`,
      bindingId: null,
      complete: !semanticResolutionBlocked(state, node, node.name),
    };
  }
  if (t.isThisExpression(node)) {
    let owner = state.parentsByNode.get(node);
    while (
      owner !== undefined &&
      !t.isClass(owner) &&
      !(t.isFunction(owner) && !t.isArrowFunctionExpression(owner))
    )
      owner = state.parentsByNode.get(owner);
    // Lexical receiver ownership does not establish one runtime instance.
    return {
      key: `this:${owner?.start ?? -1}:${owner?.end ?? -1}`,
      bindingId: null,
      complete: false,
    };
  }
  return {
    key: `expression:${String(node.start ?? -1)}:${String(node.end ?? -1)}`,
    bindingId: null,
    complete: false,
  };
};

/**
 * A timer proven to come from the Node `timers` module rather than a bare
 * global. Browser and Electron renderer sources reach this analysis without a
 * Node/browser distinction, and there `setTimeout("refresh()", 0)` is a real
 * timer: the string is evaluated by the host. Node's callback rule therefore
 * applies only when the timer is imported from `node:timers`, where that form
 * cannot exist.
 */
const nodeBuiltinTimerMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticTimerOperation["method"] | null =>
  admittedTimerMethod(
    builtinDataEffectMethod(callee, state, ["timers", "node:timers"]) ?? "",
  );

/**
 * A schedule imported from Node's `timers` module requires a function in
 * argument 0. Node validates it before creating a handle, so a provable literal
 * that is not a function throws ERR_INVALID_ARG_TYPE synchronously and no timer
 * exists. Only literals the analyzer can read exactly are decided; an identifier
 * or call may still be a function at runtime.
 */
const schedulesWithNonFunctionCallback = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
    return false;
  const callback = resolvePositionalArgument(node.arguments, 0, state);
  return rejectsEventListener(callback, state);
};

const collectTimer = (input: TimerCollectionInput): void => {
  const { node, ownerCallableId, state, output, ancestors } = input;
  const method = timerMethod(node.callee, state);
  if (method === null) return;
  if (
    TIMER_SCHEDULE_METHODS.some((candidate) => candidate === method) &&
    nodeBuiltinTimerMethod(node.callee, state) !== null &&
    schedulesWithNonFunctionCallback(node, input.state)
  )
    return;
  const kind = TIMER_SCHEDULE_METHODS.some((candidate) => candidate === method)
    ? "schedule"
    : "cancel";
  const projectedResultBindings = assignedSemanticResultBindings(
    node,
    ancestors,
    state,
  );
  const handle =
    kind === "cancel" && t.isIdentifier(node.arguments[0])
      ? resolveSemanticBindingState(
          state,
          node.arguments[0],
          node.arguments[0].name,
        )
      : undefined;
  const handleRead =
    handle === undefined || !t.isIdentifier(node.arguments[0])
      ? null
      : (() => {
          const snapshot = semanticBindingAtRead(
            handle,
            node.arguments[0],
            state,
          );
          // A const handle has the same value inside a later closure even
          // when the source positions belong to different function bodies.
          const stableClosureCapture =
            !handle.mutable &&
            handle.initializers.length === 1 &&
            handle.referenceInitializers.length === 0;
          const origins = [
            ...snapshot.binding.initializers,
            ...snapshot.binding.referenceInitializers,
          ];
          return {
            origins: origins.map(({ node: origin }) => origin),
            complete: snapshot.status === "ordered" || stableClosureCapture,
          };
        })();
  output.push({
    node,
    method,
    kind,
    ownerCallableId,
    handleBindingId:
      kind === "schedule"
        ? scalarAssignedResultBinding(projectedResultBindings)
        : dataEffectArgumentBindingId(node.arguments[0], state),
    projectedResultBindings:
      kind === "schedule"
        ? semanticProjectedBindingFacts(
            projectedResultBindings.filter(
              ({ projectionPath }) => projectionPath.length > 0,
            ),
          )
        : [],
    handleRead,
  });
};

const resolveTimers = (
  candidates: readonly TimerCandidate[],
): JavaScriptSemanticTimerOperation[] => {
  const schedules = new Map<t.Node, TimerCandidate>(
    candidates
      .filter(({ kind }) => kind === "schedule")
      .map((candidate) => [candidate.node, candidate] as const),
  );
  return candidates.map((candidate) => {
    // Unordered reads retain possible initializers as candidate edges. Only an
    // ordered or immutable read can establish one complete cancellation link.
    const linked =
      candidate.handleRead?.origins.flatMap((origin) => {
        const schedule = schedules.get(origin);
        // A handle always clears its own family. Clearing across families is
        // runtime-dependent, so it establishes no link in either direction.
        if (
          schedule === undefined ||
          timerHandleFamily(schedule.method) !==
            timerHandleFamily(candidate.method)
        )
          return [];
        return [schedule];
      }) ?? [];
    const incompleteOrigins =
      candidate.handleRead !== null &&
      candidate.handleRead.origins.length !== linked.length;
    return {
      timerId: timerId(candidate),
      kind: candidate.kind,
      method: candidate.method,
      location: range(candidate.node),
      ownerCallableId: candidate.ownerCallableId,
      handleBindingId: candidate.handleBindingId,
      projectedResultBindings: candidate.projectedResultBindings,
      linkedTimerId:
        linked.length === 1 && linked[0] !== undefined
          ? timerId(linked[0])
          : null,
      delayMilliseconds: timerDelay(candidate),
      resolution:
        candidate.kind === "schedule"
          ? "complete"
          : linked.length === 1 &&
              candidate.handleRead?.complete &&
              !incompleteOrigins &&
              !linked[0]?.projectedResultBindings.some(
                ({ bindingId }) => bindingId === candidate.handleBindingId,
              )
            ? "complete"
            : linked.length > 0
              ? "partial"
              : "unresolved",
    };
  });
};

const timerMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticTimerOperation["method"] | null => {
  if (t.isIdentifier(callee)) {
    const binding = resolveSemanticBindingState(state, callee, callee.name);
    if (binding === undefined) {
      const method = admittedTimerMethod(callee.name);
      if (method === null) return null;
      return semanticResolutionBlocked(state, callee, callee.name) ||
        !isUnmodifiedGlobalReference(callee, state, callee.name)
        ? null
        : method;
    }
  }
  return admittedTimerMethod(
    builtinDataEffectMethod(callee, state, ["timers", "node:timers"]) ?? "",
  );
};
const admittedTimerMethod = (
  value: string,
): JavaScriptSemanticTimerOperation["method"] | null =>
  [...TIMER_SCHEDULE_METHODS, ...TIMER_CANCEL_METHODS].find(
    (candidate) => candidate === value,
  ) ?? null;

const timerDelay = (candidate: TimerCandidate): number | null => {
  if (candidate.kind !== "schedule" || candidate.method === "setImmediate")
    return null;
  const delay = candidate.node.arguments[1];
  // An overflowing literal such as 1e999 parses to Infinity, which JSON
  // Evidence cannot carry; keep that delay unknown like any other.
  return t.isNumericLiteral(delay) && Number.isFinite(delay.value)
    ? delay.value
    : null;
};

const timerId = (candidate: TimerCandidate): string =>
  `timer:${candidate.kind}:${String(candidate.node.start ?? -1)}:${String(candidate.node.end ?? -1)}`;
