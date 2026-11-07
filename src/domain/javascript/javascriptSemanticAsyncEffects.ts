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
  semanticOpaqueBindingReadMayHaveChanged,
  semanticOpaqueNameMayHaveChanged,
} from "./javascriptSemanticOpaqueEffects.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
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
): boolean | undefined => {
  const unwrapped = unwrapJavaScriptExpression(node).node;
  const direct = staticJavaScriptTruthiness(unwrapped);
  if (direct !== undefined) return direct;
  if (t.isRegExpLiteral(unwrapped) || t.isClassExpression(unwrapped))
    return true;
  if (t.isUnaryExpression(unwrapped)) {
    if (unwrapped.operator === "void") return false;
    if (unwrapped.operator === "typeof") return true;
    if (unwrapped.operator === "!") {
      const inner = staticExpressionTruthiness(unwrapped.argument, state);
      return inner === undefined ? undefined : !inner;
    }
    if (
      (unwrapped.operator === "+" || unwrapped.operator === "-") &&
      t.isNumericLiteral(unwrapped.argument)
    ) {
      return (
        unwrapped.argument.value !== 0 &&
        !Number.isNaN(unwrapped.argument.value)
      );
    }
  }
  if (
    t.isIdentifier(unwrapped) &&
    isUnmodifiedGlobalReference(unwrapped, state, unwrapped.name) &&
    !semanticOpaqueNameMayHaveChanged(unwrapped, state)
  ) {
    if (unwrapped.name === "undefined" || unwrapped.name === "NaN")
      return false;
    if (unwrapped.name === "Infinity") return true;
  }
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
    if (["+", "-", "~", "!", "typeof"].includes(unwrapped.operator))
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
    t.isRegExpLiteral(unwrapped)
  )
    return false;
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
    if (t.isSpreadElement(current.node)) return false;
    const unwrapped = unwrapJavaScriptExpression(current.node);
    const depth = current.depth + unwrapped.depth;
    if (depth > SEMANTIC_EXPRESSION_DEPTH_LIMIT) {
      state.valueResourceLimits.add("expression-depth");
      return false;
    }
    const value = unwrapped.node;
    if (t.isConditionalExpression(value)) {
      const truthiness = staticExpressionTruthiness(value.test, state);
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
        const truthiness = staticExpressionTruthiness(value.left, state);
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
        const truthiness = staticExpressionTruthiness(value.left, state);
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
        const truthiness = staticExpressionTruthiness(value.left, state);
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
        const truthiness = staticExpressionTruthiness(value.left, state);
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
      t.isObjectExpression(value)
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

/** Check whether prototype, module, or escape effects may have changed Node's listener methods. */
const hasInheritedListenerMethodOverride = (
  state: JavaScriptSemanticAnalysisState,
  target: "child_process" | "events" | "process",
  call?: t.Node,
): boolean => {
  for (const binding of state.bindingsById.values()) {
    if (binding.memberWrites.length === 0 && binding.escapedPaths.length === 0)
      continue;
    const provenance = evaluateSemanticProvenance(binding, state);
    if (provenance.status !== "module") continue;
    for (const origin of provenance.origins) {
      const specifier = origin.specifier.replace(/^node:/u, "");
      if (target === "child_process" && specifier === "child_process") {
        const isClass = origin.importedPath[0] === "ChildProcess";
        const isNamespace = origin.importedPath.length === 0;
        if (
          isClass ||
          (isNamespace &&
            binding.escapedPaths.some(
              (effect) => call === undefined || effect.node !== call,
            )) ||
          binding.memberWrites.some(({ path }) =>
            path.some(
              (segment) =>
                segment === "prototype" || segment === "ChildProcess",
            ),
          )
        )
          return true;
      }
      if (
        (target === "events" ||
          target === "child_process" ||
          target === "process") &&
        specifier === "events"
      ) {
        const isClass = origin.importedPath[0] === "EventEmitter";
        const isNamespace = origin.importedPath.length === 0;
        if (
          isClass ||
          (isNamespace &&
            binding.escapedPaths.some(
              (effect) => call === undefined || effect.node !== call,
            )) ||
          binding.memberWrites.some(({ path }) =>
            path.some(
              (segment) =>
                segment === "prototype" || segment === "EventEmitter",
            ),
          )
        )
          return true;
      }
      if (target === "process" && specifier === "process") {
        const isNamespace =
          origin.importedPath.length === 0 ||
          (origin.importedPath.length === 1 &&
            origin.importedPath[0] === "default");
        if (
          binding.memberWrites.some(({ path }) =>
            path.some(
              (segment) =>
                segment === "prototype" ||
                EVENT_LISTENER_METHODS.includes(
                  segment as (typeof EVENT_LISTENER_METHODS)[number],
                ),
            ),
          ) ||
          (isNamespace &&
            binding.escapedPaths.some(
              (effect) => call === undefined || effect.node !== call,
            ))
        )
          return true;
      }
    }
  }
  for (const [specifier, effects] of state.requiredModuleEffects.entries()) {
    const raw = specifier.replace(/^node:/u, "");
    if (target === "child_process" && raw === "child_process") {
      if (
        effects.some(
          ({ kind, path, node }) =>
            (kind === "write" &&
              path.some(
                (segment) =>
                  segment === "prototype" || segment === "ChildProcess",
              )) ||
            (kind === "escape" &&
              (call === undefined || node !== call) &&
              (path.length === 0 ||
                path.some(
                  (segment) =>
                    segment === "prototype" || segment === "ChildProcess",
                ))),
        )
      )
        return true;
    }
    if (
      (target === "events" ||
        target === "child_process" ||
        target === "process") &&
      raw === "events"
    ) {
      if (
        effects.some(
          ({ kind, path, node }) =>
            (kind === "write" &&
              path.some(
                (segment) =>
                  segment === "prototype" || segment === "EventEmitter",
              )) ||
            (kind === "escape" &&
              (call === undefined || node !== call) &&
              (path.length === 0 ||
                path.some(
                  (segment) =>
                    segment === "prototype" || segment === "EventEmitter",
                ))),
        )
      )
        return true;
    }
    if (target === "process" && raw === "process") {
      if (
        effects.some(
          ({ kind, path, node }) =>
            (kind === "write" &&
              (path.length === 0 ||
                path.some(
                  (segment) =>
                    segment === "prototype" ||
                    EVENT_LISTENER_METHODS.includes(
                      segment as (typeof EVENT_LISTENER_METHODS)[number],
                    ),
                ))) ||
            (kind === "escape" &&
              (call === undefined || node !== call) &&
              (path.length === 0 ||
                path.some(
                  (segment) =>
                    segment === "prototype" ||
                    EVENT_LISTENER_METHODS.includes(
                      segment as (typeof EVENT_LISTENER_METHODS)[number],
                    ),
                ))),
        )
      )
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
      state.ambientWriteEffects.some(
        ({ path, node }) =>
          (call === undefined || node !== call) &&
          ((path[0] === "process" &&
            (path.length <= 1 ||
              EVENT_LISTENER_METHODS.includes(
                path[1] as (typeof EVENT_LISTENER_METHODS)[number],
              ))) ||
            (path[0] === "global" &&
              path[1] === "process" &&
              (path.length <= 2 ||
                EVENT_LISTENER_METHODS.includes(
                  path[2] as (typeof EVENT_LISTENER_METHODS)[number],
                )))),
      )
    )
      return true;
    if (
      state.ambientEscapeEffects.some(
        ({ path, node }) =>
          (call === undefined || node !== call) &&
          ((path[0] === "process" &&
            (path.length <= 1 ||
              EVENT_LISTENER_METHODS.includes(
                path[1] as (typeof EVENT_LISTENER_METHODS)[number],
              ))) ||
            (path[0] === "global" &&
              path[1] === "process" &&
              (path.length <= 2 ||
                EVENT_LISTENER_METHODS.includes(
                  path[2] as (typeof EVENT_LISTENER_METHODS)[number],
                )))),
      )
    )
      return true;
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
  if (!t.isIdentifier(constructor)) return false;
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
  visitedBindings: ReadonlySet<string> = new Set(),
): boolean => {
  const unwrapped = unwrapJavaScriptExpression(receiver).node;
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
      semanticGlobalProcessPathOrigin(unwrapped, state)?.importedPath.length ===
        0)
  ) {
    return !hasInheritedListenerMethodOverride(state, "process", call);
  }
  if (!t.isIdentifier(unwrapped)) return false;
  const binding = resolveSemanticBindingState(state, unwrapped, unwrapped.name);
  if (binding === undefined || visitedBindings.has(binding.bindingId))
    return false;
  if (
    binding.mutable &&
    semanticOpaqueBindingReadMayHaveChanged(binding, unwrapped, state)
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
        !semanticTopLevelEffectFollowsCapture(call, node, state.parentsByNode),
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
      semanticGlobalProcessPathOrigin(initNode, state)?.importedPath.length ===
        0)
  ) {
    return !hasInheritedListenerMethodOverride(state, "process", call);
  }
  if (t.isIdentifier(initNode)) {
    return isProvenNodeEmitter(
      initNode,
      call,
      state,
      new Set([...visitedBindings, binding.bindingId]),
    );
  }
  return isProvenCreationNode(initNode, state, initNode);
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
  const eventArgument = node.arguments[0];
  const listenerMethod = EVENT_LISTENER_METHODS.includes(method);
  const listenerArgument = listenerMethod ? node.arguments[1] : undefined;
  // A leading spread shifts the runtime argument positions, so argument 1 is not
  // provably the listener: `e.on(...["x", fn], 1)` registers `fn` and ignores the
  // trailing `1`.
  const invalidNodeListener =
    listenerMethod &&
    !t.isSpreadElement(eventArgument) &&
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
): boolean =>
  (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
  rejectsEventListener(node.arguments[0], state);

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
