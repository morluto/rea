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
import {
  isUnmodifiedGlobalReference,
  semanticAmbientPathMayHaveChangedAt,
} from "./javascriptSemanticAmbientWrites.js";
import {
  semanticOpaqueNameMayHaveChanged,
  semanticSharedModuleMayHaveOpaqueEffect,
} from "./javascriptSemanticOpaqueEffects.js";
import type { JavaScriptSemanticPropertyPath } from "./javascriptSemanticPropertyPaths.js";
import { range } from "./javascriptStaticAnalysisHelpers.js";
import { evaluateSemanticProvenance } from "./javascriptSemanticValues.js";
import {
  affectsBuiltinPath,
  builtinDataEffectCallablePath,
  builtinDataEffectIdentity,
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
  readonly builtinAuthority?: "candidate";
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
  // Mutation facts are complete before this collection. Share only matching
  // records within this pass; every read still decides its own timing.
  let emitterEffects: EventEmitterSharedEffects | undefined;
  const sharedEmitterEffects = (): EventEmitterSharedEffects =>
    (emitterEffects ??= indexEventEmitterSharedEffects(state));
  const timers: TimerCandidate[] = [];
  const callableIds = new Set(callables.map(({ callableId }) => callableId));
  const callableStack = createSemanticCallableIdStack(callableIds);
  const ancestors: t.Node[] = [];
  traverseJavaScriptValueAst(program, state.erasedSyntaxNodes, {
    enter: (node, parent) => {
      callableStack.enter(node, parent);
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const ownerCallableId = callableStack.callables.at(-1) ?? null;
        collectEvent(
          node,
          ownerCallableId,
          state,
          events,
          sharedEmitterEffects,
        );
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
 * Report whether a value is `new <events>.EventEmitter()`. Named and default
 * imports, destructured requires, and member requires all denote that class.
 * The construction is returned so the caller reads `callee` from the unwrapped
 * `NewExpression` rather than from a wrapper around it.
 */
const nodeEventEmitterConstruction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.NewExpression | null => {
  const value = unwrapJavaScriptExpression(node).node;
  if (!t.isNewExpression(value)) return null;
  const selected = builtinDataEffectCallablePath(
    value.callee,
    state,
    NODE_EVENTS_SPECIFIERS,
  );
  if (selected === null) return null;
  // An empty selected path is the module's default export, which `events`
  // defines as `EventEmitter`.
  // A suffix alone cannot prove the class: user-defined nested exports may
  // end in EventEmitter while selecting an unrelated implementation.
  return selected.length === 0 ||
    (selected.length === 1 && selected[0] === "EventEmitter")
    ? value
    : null;
};

/**
 * Resolve the identifier a construction reads the class through: the class
 * itself for `new EventEmitter()`, and the module namespace for
 * `new events.EventEmitter()`.
 */
const constructionRootBinding = (
  callee: t.Expression | t.Super,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState | undefined => {
  let node: t.Node = unwrapJavaScriptExpression(callee).node;
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
    node = unwrapJavaScriptExpression(node.object).node;
  return t.isIdentifier(node)
    ? resolveSemanticBindingState(state, node, node.name)
    : undefined;
};

/**
 * Report whether a binding can name the events module or its class, which is
 * what makes a member write on it reach the class this construction used. An
 * imported or required binding carries the module origin; a local alias such as
 * `const EE = EventEmitter` is followed through its initializer.
 */
const eventsClassPath = (path: JavaScriptSemanticPropertyPath): boolean => {
  for (let index = 0; index < path.length; index += 1) {
    const key = path[index];
    // An unknown key may select the class again; do not prove absence from it.
    if (key === null) return true;
    if (key === "EventEmitter" || key === "default") continue;
    // The standard back-reference returns from the prototype to this class.
    if (
      key === "prototype" &&
      index + 1 < path.length &&
      (path[index + 1] === "constructor" || path[index + 1] === null)
    ) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
};

/** A function's default prototype.constructor pair can reach the function again. */
const constructorBackReferenceEnd = (
  path: JavaScriptSemanticPropertyPath,
  start = 0,
  limit = path.length,
): number => {
  let end = start;
  while (
    end + 1 < limit &&
    path[end] === "prototype" &&
    path[end + 1] === "constructor"
  )
    end += 2;
  return end;
};

/** The initializer object owns the `.call` slot Node reads during allocation. */
const eventsInitializerPath = (
  path: JavaScriptSemanticPropertyPath,
): boolean => {
  const initializer = path.indexOf("init");
  return (
    initializer >= 0 &&
    eventsClassPath(path.slice(0, initializer)) &&
    constructorBackReferenceEnd(path, initializer + 1) === path.length
  );
};

const reachesEventsClassSurface = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  binding.directOrigins.some(
    ({ specifier, importedPath }) =>
      eventsClassPath(importedPath) &&
      NODE_EVENTS_SPECIFIERS.some(
        (candidate) =>
          candidate.replace(/^node:/u, "") === specifier.replace(/^node:/u, ""),
      ),
  ) ||
  binding.initializers.some(({ node }) => {
    const path = builtinDataEffectCallablePath(
      node,
      state,
      NODE_EVENTS_SPECIFIERS,
    );
    return path !== null && eventsClassPath(path);
  });

type EventEmitterEffect = t.Node | undefined;

interface EventEmitterClassEffects {
  readonly writes: readonly EventEmitterEffect[];
  readonly initializerEscapes: readonly EventEmitterEffect[];
  readonly escapes: readonly EventEmitterEffect[];
}

interface EventEmitterSharedEffects extends EventEmitterClassEffects {
  readonly otherRoots: ReadonlyMap<string, EventEmitterClassEffects>;
  readonly prototypeWrites: ReadonlyMap<string, readonly EventEmitterEffect[]>;
  readonly prototypeEscapes: readonly EventEmitterEffect[];
}

/** Unknown property keys may select any part of the construction surface. */
const targetsEventsClass = (path: JavaScriptSemanticPropertyPath): boolean =>
  path.some(
    (key) =>
      key === null ||
      key === "EventEmitter" ||
      key === "init" ||
      key === "prototype",
  );

/** Index shared matching records once, without caching a call's validity. */
const indexEventEmitterSharedEffects = (
  state: JavaScriptSemanticAnalysisState,
): EventEmitterSharedEffects => {
  const writes: EventEmitterEffect[] = [];
  const initializerEscapes: EventEmitterEffect[] = [];
  const escapes: EventEmitterEffect[] = [];
  const otherRoots = new Map<string, EventEmitterClassEffects>();
  const prototypeWrites = new Map<string, EventEmitterEffect[]>();
  const prototypeEscapes: EventEmitterEffect[] = [];
  const retainPrototypeWrite = (
    path: JavaScriptSemanticPropertyPath,
    node: EventEmitterEffect,
  ): void => {
    for (const method of EVENT_LISTENER_METHODS) {
      if (!affectsPrototypeMethod(path, method)) continue;
      const matching = prototypeWrites.get(method) ?? [];
      matching.push(node);
      prototypeWrites.set(method, matching);
    }
  };
  for (const binding of state.bindingsById.values()) {
    const classWrites = binding.memberWrites
      .filter(({ path }) => targetsEventsClass(path))
      .map(({ node }) => node);
    const classEscapes = binding.escapedPaths
      .filter(({ path }) => eventsClassPath(path))
      .map(({ node }) => node);
    const classInitializerEscapes = binding.escapedPaths
      .filter(({ path }) => eventsInitializerPath(path))
      .map(({ node }) => node);
    if (
      classWrites.length > 0 ||
      classEscapes.length > 0 ||
      classInitializerEscapes.length > 0
    ) {
      if (reachesEventsClassSurface(binding, state)) {
        for (const node of classWrites) writes.push(node);
        for (const node of classEscapes) escapes.push(node);
        for (const node of classInitializerEscapes)
          initializerEscapes.push(node);
      } else {
        // A proven construction's root remains relevant even when the general
        // class-origin predicate cannot establish that binding's surface.
        otherRoots.set(binding.bindingId, {
          writes: classWrites,
          initializerEscapes: classInitializerEscapes,
          escapes: classEscapes,
        });
      }
    }
    // A named initializer import owns its own records, rather than paths on a
    // class binding. Consume the provenance owner's retained origins, including
    // candidate origins: uncertainty can withdraw this proof, never create it.
    const initializerWrites = binding.memberWrites.filter(({ path }) => {
      // A write replaces its last slot, not the value previously stored there.
      const selected = path.slice(
        constructorBackReferenceEnd(path, 0, path.length - 1),
      );
      return (
        affectsBuiltinPath(selected, ["call"]) || selected.at(0) === "__proto__"
      );
    });
    const initializerObjectEscapes = binding.escapedPaths.filter(
      ({ path }) => constructorBackReferenceEnd(path) === path.length,
    );
    if (
      (initializerWrites.length > 0 || initializerObjectEscapes.length > 0) &&
      evaluateSemanticProvenance(binding, state).origins.some(
        ({ specifier, importedPath }) =>
          eventsInitializerPath(importedPath) &&
          NODE_EVENTS_SPECIFIERS.some(
            (candidate) =>
              candidate.replace(/^node:/u, "") ===
              specifier.replace(/^node:/u, ""),
          ),
      )
    ) {
      for (const { node } of initializerWrites) writes.push(node);
      for (const { node } of initializerObjectEscapes)
        initializerEscapes.push(node);
    }
    for (const { path, node } of binding.memberWrites)
      retainPrototypeWrite(path, node);
    for (const { path, node } of binding.escapedPaths)
      if (escapesPrototypeObject(path)) prototypeEscapes.push(node);
  }
  for (const specifier of NODE_EVENTS_SPECIFIERS)
    for (const { kind, path, node } of state.requiredModuleEffects.get(
      specifier,
    ) ?? []) {
      if (kind === "escape") {
        if (eventsClassPath(path)) escapes.push(node);
        if (eventsInitializerPath(path)) initializerEscapes.push(node);
        if (escapesPrototypeObject(path)) prototypeEscapes.push(node);
      } else {
        if (targetsEventsClass(path)) writes.push(node);
        retainPrototypeWrite(path, node);
      }
    }
  return {
    writes,
    initializerEscapes,
    escapes,
    otherRoots,
    prototypeWrites,
    prototypeEscapes,
  };
};

/**
 * Construction-only writes and initializer escapes matter before allocation.
 * An escaped initializer can gain an own `.call` wrapper without replacement.
 * Class and namespace escapes can replace the shared prototype until the
 * listener call.
 */
const eventsClassSurfaceTouched = (
  effects: EventEmitterSharedEffects,
  construction: t.NewExpression,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  invocation: t.Node,
): boolean => {
  const precedes = (read: t.Node, effect: EventEmitterEffect): boolean =>
    effect !== invocation &&
    !semanticTopLevelEffectFollowsCapture(read, effect, state.parentsByNode);
  const touched = (selected: EventEmitterClassEffects): boolean =>
    selected.escapes.some((node) => precedes(read, node)) ||
    selected.writes.some((node) => precedes(construction, node)) ||
    selected.initializerEscapes.some((node) => precedes(construction, node));
  if (touched(effects)) return true;
  const root = constructionRootBinding(construction.callee, state);
  const rootEffects =
    root === undefined ? undefined : effects.otherRoots.get(root.bindingId);
  return rootEffects !== undefined && touched(rootEffects);
};

/**
 * Report whether a recorded path can select, or replace, `prototype.<method>`.
 * The path is recorded against whichever object owns the write, so it carries
 * the owner's own prefix (`EventEmitter.prototype.on`, `events.EventEmitter
 * .prototype.on`) and only its tail names the slot. An unknown property key
 * such as `prototype[key]` covers the method as well, so the tail is compared
 * with the shared builtin-path rule instead of by exact keys.
 */
const affectsPrototypeMethod = (
  path: JavaScriptSemanticPropertyPath,
  method: string,
): boolean => {
  for (let index = 0; index < path.length; index += 1)
    if (affectsBuiltinPath(path.slice(index), ["prototype", method]))
      return true;
  return false;
};

/**
 * Report whether any object in this module writes a `prototype.<method>` slot.
 * A receiver cannot be held to the native contract once the method that answers
 * the call may have been replaced on a shared prototype. The write is recorded
 * on whichever binding owns the object, so a scan covers every spelling of it:
 * the class itself, a namespace import, a member require, or an alias of any of
 * them. A write through an inline `require(...)` has no binding at all and is
 * recorded against the module, so those records are scanned too. A file that
 * reassigns `prototype.<method>` for an unrelated class loses the proof as
 * well, which keeps the guard narrow instead of guessing which definition
 * answers the call.
 */
const writesPrototypeMethod = (
  effects: EventEmitterSharedEffects,
  method: string,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  (effects.prototypeWrites.get(method) ?? []).some(
    (write) =>
      !semanticTopLevelEffectFollowsCapture(read, write, state.parentsByNode),
  );

/**
 * Report whether an escape hands out the prototype object itself. Reading a
 * method and passing the function value out (`proto.on`) cannot change the
 * prototype, but passing the object (`configure(proto)`) lets the call install
 * a replacement method on it.
 */
const escapesPrototypeObject = (
  path: JavaScriptSemanticPropertyPath,
): boolean =>
  path.length > 0 &&
  (path.at(-1) === "prototype" ||
    path.at(-1) === "__proto__" ||
    path.at(-1) === null);

/**
 * Report whether the shared prototype may have gained a method through a call.
 * The prototype escapes exactly like an instance does, and the callee can
 * install a defaulting wrapper on it, so the class no longer answers with the
 * method it defines.
 */
const prototypeObjectEscaped = (
  effects: EventEmitterSharedEffects,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  effects.prototypeEscapes.some(
    (escape) =>
      !semanticTopLevelEffectFollowsCapture(read, escape, state.parentsByNode),
  );

/**
 * Report whether the receiver is a value this module constructs from Node's
 * `EventEmitter` and still calls the native listener method. Only that class is
 * bound by `checkListener`; other EventEmitter-style APIs define one-argument
 * forms, such as Socket.IO's `socket.off("x")`, which removes every listener
 * for the event. Any receiver whose selected method may have been replaced
 * keeps its operation as an unresolved candidate.
 */
const nodeEventEmitterReceiver = (
  node: t.Expression | t.Super,
  method: string,
  state: JavaScriptSemanticAnalysisState,
  call: t.Node,
  sharedEffects: () => EventEmitterSharedEffects,
): boolean => {
  if (!t.isIdentifier(node)) return false;
  const binding = resolveSemanticBindingState(state, node, node.name);
  if (binding === undefined) return false;
  const initializer = semanticStableInitializer(binding, state);
  if (initializer === undefined || initializer.projection.length !== 0)
    return false;
  const construction = nodeEventEmitterConstruction(initializer.node, state);
  if (construction === null) return false;
  // Node allocates through EventEmitter.init.call(this, opts). The inherited
  // call slot is shared by functions, so its ambient effects belong to the
  // allocation even when no events binding was written or exposed.
  if (
    semanticAmbientPathMayHaveChangedAt(construction, state, [
      "global",
      "Function",
      "prototype",
      "call",
    ])
  )
    return false;
  // Reaching the class is not the same as reaching the method: the class object
  // and the `init` hook Node runs while constructing can both be reshaped, so a
  // construction whose surface was touched keeps its operation.
  const effects = sharedEffects();
  if (eventsClassSurfaceTouched(effects, construction, node, state, call))
    return false;
  // The receiver is activation-local, but the events module and its prototype
  // are shared: opaque code in an outer activation can replace their methods
  // even when this receiver does not exist yet. Use the opaque-effect owner's
  // shared-identity query rather than interpreting eval text here.
  if (semanticSharedModuleMayHaveOpaqueEffect(node, state)) return false;
  // Constructing the class proves where the receiver came from, not which
  // definition answers the call. Passing the instance to another call lets that
  // call replace the method first, so the proof no longer holds. Reading
  // `emitter.on` in order to call it passes the function value rather than the
  // instance, and the collector records the operation's own call as one of
  // these escapes, so that call is not evidence against the receiver. A call
  // that runs after this one cannot change whether it threw, so it is not
  // evidence either.
  if (
    binding.escapedPaths.some(
      (escape) =>
        escape.path.length === 0 &&
        escape.node !== call &&
        !semanticTopLevelEffectFollowsCapture(
          call,
          escape.node,
          state.parentsByNode,
        ),
    )
  )
    return false;
  // A member write replaces the selected method, so it no longer keeps the
  // native contract. An unrelated write such as `emitter.tag = 1` leaves the
  // proof intact. Replacing the receiver's own prototype selects a different
  // method as well, and is recorded as a `__proto__` write.
  if (
    binding.memberWrites.some(
      ({ path, node: write }) =>
        (affectsBuiltinPath(path, [method]) || path.at(0) === "__proto__") &&
        !semanticTopLevelEffectFollowsCapture(node, write, state.parentsByNode),
    )
  )
    return false;
  // Every instance shares the constructor's prototype, so a write there
  // replaces the method for this receiver as well, and so does handing that
  // prototype to a call that may install the method itself.
  return (
    !writesPrototypeMethod(effects, method, node, state) &&
    !prototypeObjectEscaped(effects, node, state)
  );
};

const collectEvent = (
  node: t.CallExpression | t.OptionalCallExpression,
  ownerCallableId: string | null,
  state: JavaScriptSemanticAnalysisState,
  output: JavaScriptSemanticEventOperation[],
  sharedEffects: () => EventEmitterSharedEffects,
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
    nodeEventEmitterReceiver(member.object, method, state, node, sharedEffects)
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
 * A timer associated with the Node `timers` module, either proven or
 * conditional, rather than a bare global. Browser and Electron renderer sources
 * reach this analysis without a Node/browser distinction, and there `setTimeout("refresh()", 0)` is a real
 * timer: the string is evaluated by the host. Node's callback rule therefore
 * applies when interpreting the call as `node:timers`, where that form
 * cannot create a Node timer even if the module identity is conditional.
 */
const nodeBuiltinTimerMethod = (
  callee: t.Node,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticTimerOperation["method"] | null => {
  const identity = builtinDataEffectIdentity(callee, state, [
    "timers",
    "node:timers",
  ]);
  return admittedTimerMethod(
    identity?.path.length === 1 ? (identity.path[0] ?? "") : "",
  );
};

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
  const argument = node.arguments[0];
  // No argument at all cannot be a function. A spread may still expand to one.
  if (argument === undefined) return true;
  if (t.isSpreadElement(argument)) return false;
  const value = unwrapJavaScriptExpression(argument).node;
  if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value))
    return false;
  if (
    t.isStringLiteral(value) ||
    t.isNumericLiteral(value) ||
    t.isBigIntLiteral(value) ||
    t.isBooleanLiteral(value) ||
    t.isNullLiteral(value) ||
    t.isTemplateLiteral(value) ||
    t.isArrayExpression(value) ||
    t.isObjectExpression(value)
  )
    return true;
  // `undefined`, `NaN` and `Infinity` are unmodified globals, and none is a
  // function. A shadowed binding may still hold one, so only the global counts.
  if (
    t.isIdentifier(value) &&
    ["undefined", "NaN", "Infinity"].includes(value.name) &&
    isUnmodifiedGlobalReference(value, state, value.name) &&
    !semanticOpaqueNameMayHaveChanged(value, state)
  )
    return true;
  // A class passes Node's own typeof check; invoking it is a separate failure,
  // so the schedule itself still happens. Every other unary operator (including
  // `void`, `!`, `~`, `typeof` and `delete`) yields a primitive, never a
  // function.
  return t.isUnaryExpression(value);
};

const collectTimer = (input: TimerCollectionInput): void => {
  const { node, ownerCallableId, state, output, ancestors } = input;
  const identity = timerMethod(node.callee, state);
  if (identity === null) return;
  const { method, builtinAuthority } = identity;
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
    ...(builtinAuthority === undefined ? {} : { builtinAuthority }),
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
      ...(candidate.builtinAuthority === "candidate" ||
      linked.some((item) => item.builtinAuthority === "candidate")
        ? { builtinAuthority: "candidate" as const }
        : {}),
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
): {
  readonly method: JavaScriptSemanticTimerOperation["method"];
  readonly builtinAuthority?: "candidate";
} | null => {
  if (t.isIdentifier(callee)) {
    const binding = resolveSemanticBindingState(state, callee, callee.name);
    if (binding === undefined) {
      const method = admittedTimerMethod(callee.name);
      if (method === null) return null;
      return semanticResolutionBlocked(state, callee, callee.name) ||
        !isUnmodifiedGlobalReference(callee, state, callee.name)
        ? null
        : { method };
    }
  }
  const identity = builtinDataEffectIdentity(callee, state, [
    "timers",
    "node:timers",
  ]);
  const method = admittedTimerMethod(
    identity?.path.length === 1 ? (identity.path[0] ?? "") : "",
  );
  return method === null
    ? null
    : {
        method,
        ...(identity?.builtinAuthority === undefined
          ? {}
          : { builtinAuthority: identity.builtinAuthority }),
      };
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
