import * as t from "@babel/types";

import type {
  JavaScriptSemanticCallable,
  JavaScriptSemanticProjectedResultBinding,
  JavaScriptSemanticEventOperation,
  JavaScriptSemanticTimerOperation,
} from "./javascriptSemanticIr.js";
import { createSemanticCallableIdStack } from "./javascriptSemanticCallableStack.js";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  semanticBindingAtRead,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import { traverseJavaScriptValueAst } from "./javascriptSemanticTraversal.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import {
  affectsBuiltinPath,
  builtinDataEffectCallablePath,
  builtinDataEffectMethod,
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

/**
 * A listener must be a function, and Node throws `ERR_INVALID_ARG_TYPE` before
 * anything is registered or removed when it is not. An exactly readable literal
 * that cannot be a function is therefore not an event operation, while an
 * identifier, a call result or a spread may still supply one and keeps its
 * operation.
 *
 * A class expression passes Node's own `typeof` check, so it is kept.
 */
const rejectsEventListener = (listener: t.Node): boolean => {
  if (t.isSpreadElement(listener)) return false;
  const value = unwrapJavaScriptExpression(listener).node;
  if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value))
    return false;
  if (t.isClassExpression(value)) return false;
  // A numeric literal is always a number, including the non-finite value Babel
  // stores for `1e999`, which the exact-value reader refuses to price.
  if (t.isNumericLiteral(value)) return true;
  // Every unary operator yields a primitive, and a primitive is never callable.
  return (
    t.isUnaryExpression(value) ||
    readExactJavaScriptLiteral(value).found ||
    t.isTemplateLiteral(value) ||
    t.isBigIntLiteral(value) ||
    t.isRegExpLiteral(value) ||
    t.isArrayExpression(value) ||
    t.isObjectExpression(value)
  );
};

/**
 * Node's `events` module, whose `EventEmitter` validates every listener
 * argument before it registers or removes anything.
 */
const NODE_EVENTS_SPECIFIERS = ["events", "node:events"] as const;

/**
 * Report whether a constructor reference resolves to Node's `EventEmitter`.
 * Named and default imports, destructured requires, and member requires all
 * denote that class.
 */
const isNodeEventEmitterConstructor = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const value = unwrapJavaScriptExpression(node).node;
  if (!t.isNewExpression(value)) return false;
  const selected = builtinDataEffectCallablePath(
    value.callee,
    state,
    NODE_EVENTS_SPECIFIERS,
  );
  // An empty selected path is the module's default export, which `events`
  // defines as `EventEmitter`.
  return (
    selected !== null &&
    (selected.length === 0 || selected.at(-1) === "EventEmitter")
  );
};

/**
 * Report whether the receiver is a value this module constructs from Node's
 * `EventEmitter`. Only that class is bound by `checkListener`; other
 * EventEmitter-style APIs define one-argument forms, such as Socket.IO's
 * `socket.off("x")`, which removes every listener for the event. A receiver
 * that is not proven this way keeps its operation as an unresolved candidate.
 */
const nodeEventEmitterReceiver = (
  node: t.Expression | t.Super,
  method: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!t.isIdentifier(node)) return false;
  const binding = resolveSemanticBindingState(state, node, node.name);
  if (binding === undefined) return false;
  const initializer = semanticStableInitializer(binding, state);
  if (
    initializer === undefined ||
    initializer.projection.length !== 0 ||
    !isNodeEventEmitterConstructor(initializer.node, state)
  )
    return false;
  // Constructing the class proves where the receiver came from, not which
  // definition answers the call. A member write replaces the selected method,
  // so it no longer keeps the native contract. An unrelated write such as
  // `emitter.tag = 1` leaves the proof intact.
  if (
    binding.memberWrites.some(
      ({ path, node: write }) =>
        affectsBuiltinPath(path, [method]) &&
        !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
    )
  )
    return false;
  // Every instance shares the constructor's prototype, so a write there
  // replaces the method for this receiver as well.
  const constructed = (initializer.node as t.NewExpression).callee;
  const structural = unwrapJavaScriptExpression(constructed).node;
  if (!t.isIdentifier(structural)) return true;
  const constructorBinding = resolveSemanticBindingState(
    state,
    structural,
    structural.name,
  );
  if (constructorBinding === undefined) return false;
  return !constructorBinding.memberWrites.some(
    ({ path, node: write }) =>
      affectsBuiltinPath(path, ["prototype", method]) &&
      !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
  );
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
  // A listener method called without a listener argument passes `undefined` to
  // Node's `checkListener`, which throws before it registers or removes
  // anything. Only a spread argument can still reach that position, and only a
  // receiver proven to be Node's `EventEmitter` is held to that contract.
  if (
    listenerMethod &&
    listenerArgument === undefined &&
    !node.arguments.some((argument) => t.isSpreadElement(argument)) &&
    nodeEventEmitterReceiver(member.object, method, state)
  )
    return;
  // A leading spread shifts the runtime argument positions, so argument 1 is not
  // provably the listener: `e.on(...["x", fn], 1)` registers `fn` and ignores the
  // trailing `1`.
  if (
    !t.isSpreadElement(eventArgument) &&
    listenerArgument !== undefined &&
    rejectsEventListener(listenerArgument)
  )
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
        : emitter.complete
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
      const read = semanticBindingAtRead(binding, node, state.parentsByNode);
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

const collectTimer = (input: TimerCollectionInput): void => {
  const { node, ownerCallableId, state, output, ancestors } = input;
  const method = timerMethod(node.callee, state);
  if (method === null) return;
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
            state.parentsByNode,
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
        return schedule === undefined ? [] : [schedule];
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
