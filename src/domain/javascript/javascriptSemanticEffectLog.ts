/**
 * The effect log: one owner of the questions readers ask about recorded
 * effects (docs/adr/javascript/pushed-effect-invalidation.md). Readers ask
 * whether a read may observe an effect; the timing, capture and path proofs
 * stay here. Recorded opaque sites live in javascriptSemanticEffectRecord.ts.
 */
import * as t from "@babel/types";
import { javaScriptProgramStrictness } from "./javascriptSourceParser.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  invalidateSemanticEscapedPath,
  invalidateSemanticMutationPaths,
} from "./javascriptSemanticMutationValues.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";
import type { SemanticAliasSelectionPath } from "./javascriptSemanticAliasSelections.js";
import {
  semanticEffectPathCandidates,
  semanticEffectPathMatches,
  semanticSomeEffectPathCandidate,
} from "./javascriptSemanticEffectPathIndex.js";
import {
  isUnshadowedGlobal,
  semanticBindingEffectFollowsCapture,
  semanticEscapeFollowsCapture,
  semanticDefiniteEffectPrecedesReference,
  semanticEffectTiming,
  semanticBindingEffectFollowsRead,
  semanticReadPrecedesEffectWithinActivation,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import {
  resolveSemanticBindingState,
  semanticBindingLookupAt,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticMemberEffect,
  type JavaScriptSemanticReferenceEffectsAtSite,
} from "./javascriptSemanticState.js";

export const indexSemanticOpaqueEffects = (
  candidates: readonly {
    node: t.CallExpression;
    scopeId: string;
  }[],
  state: JavaScriptSemanticAnalysisState,
): void => {
  for (const { node, scopeId } of candidates) {
    const callee = unwrapJavaScriptExpression(node.callee).node;
    if (!isUnshadowedGlobal(callee, state, "eval")) continue;
    state.opaqueEffects.sites.add(node);
    if (!strictEval(node, state)) state.opaqueEffects.sloppySites.add(node);
    const sites = state.opaqueEffects.byScope.get(scopeId) ?? [];
    sites.push(node);
    state.opaqueEffects.byScope.set(scopeId, sites);
    let scope = state.scopesById.get(scopeId);
    while (scope?.parentScopeId != null) {
      const children =
        state.opaqueEffects.children.get(scope.parentScopeId) ??
        new Set<string>();
      if (children.has(scope.scopeId)) break;
      children.add(scope.scopeId);
      state.opaqueEffects.children.set(scope.parentScopeId, children);
      scope = state.scopesById.get(scope.parentScopeId);
    }
  }
};

/** The existing ambient invocation walk owns global effects; ordinary sources
 * neither retain a second call list nor create another alias resolver. */
export const createSemanticOpaqueGlobalObserver = (
  state: JavaScriptSemanticAnalysisState,
  dependencies: {
    createAmbientPathResolver: (
      state: JavaScriptSemanticAnalysisState,
      observeGlobals: boolean,
    ) => (
      node: t.Node,
      site: t.Node | undefined,
    ) => {
      paths: readonly (readonly (string | null)[])[];
      callerPaths: readonly (readonly (string | null)[])[];
    };
    createSemanticModuleInterop: (
      state: JavaScriptSemanticAnalysisState,
      options?: {
        intrinsicPath: (node: t.Node) => readonly string[] | undefined;
      },
    ) => {
      intrinsicPath: (node: t.Node) => readonly string[] | undefined;
      intrinsicInvocation: (
        node:
          | t.CallExpression
          | t.OptionalCallExpression
          | t.NewExpression
          | t.TaggedTemplateExpression,
      ) => { readonly path: readonly string[] } | undefined;
    };
  },
): ((node: t.Node) => void) | undefined => {
  if (!state.opaqueEffects.mayReferenceGlobalCode) return undefined;
  const ambientPaths = dependencies.createAmbientPathResolver(state, true);
  let invocationSite: t.Node | undefined;
  const interop = dependencies.createSemanticModuleInterop(state, {
    intrinsicPath: (node) => {
      const { paths, callerPaths } = ambientPaths(node, invocationSite);
      const path =
        paths.find((path) => path[1] === "eval" || path[1] === "Function") ??
        callerPaths.find(
          (path) => path[1] === "eval" || path[1] === "Function",
        ) ??
        paths[0];
      if (path?.[0] !== "global" || path.some((key) => key === null))
        return undefined;
      // Keep the global callable owner for generic call/apply/bind resolution.
      return path[1] === "eval" || path[1] === "Function"
        ? ["intrinsic", ...(path as readonly string[])]
        : ["intrinsic", ...(path.slice(1) as readonly string[])];
    },
  });
  return (node) => {
    if (
      !t.isCallExpression(node) &&
      !t.isOptionalCallExpression(node) &&
      !t.isNewExpression(node) &&
      !t.isTaggedTemplateExpression(node)
    )
      return;
    invocationSite = node;
    const path = interop.intrinsicInvocation(node)?.path;
    // Constructed code may escape and activate a classic-script global. Keep
    // its creation as a conservative timing bound, not proof of execution.
    if (
      path?.join(".") === "intrinsic.global.eval" ||
      path?.join(".") === "intrinsic.global.Function"
    )
      state.opaqueEffects.globalSites.push(node);
  };
};

/** Global code can affect globals, but cannot rebind its caller's locals. */
const semanticOpaqueGlobalMayHaveChanged = (
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  state.opaqueEffects.globalSites.some(
    (effect) => semanticEffectTiming(read, effect, state) !== "after",
  );

/** Rebinding requires lexical visibility. Object references can remain reachable
 * through aliases even where the original name is shadowed or out of block scope.
 * Without a disjointness proof, consider their enclosing activation and closures.
 * Queries retain no binding-by-eval table. */
function* semanticOpaqueBindingEffects(
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  kind: "binding" | "reference" = "binding",
): Generator<t.CallExpression> {
  if (state.opaqueEffects.byScope.size === 0) return;
  const pending = [
    kind === "reference" ? activation(binding.scopeId, state) : binding.scopeId,
  ];
  while (pending.length > 0) {
    const scope = pending.pop()!;
    for (const node of state.opaqueEffects.byScope.get(scope) ?? [])
      if (
        kind === "reference" ||
        resolveSemanticBindingState(state, node, binding.name)?.bindingId ===
          binding.bindingId
      )
        yield node;
    for (const child of state.opaqueEffects.children.get(scope) ?? [])
      pending.push(child);
  }
}

const semanticBindingMayHaveOpaqueEffect = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  read?: t.Node,
  kind: "binding" | "reference" = "binding",
): boolean => {
  if (state.opaqueEffects.byScope.size === 0) return false;
  for (const effect of semanticOpaqueBindingEffects(binding, state, kind))
    if (
      read === undefined ||
      (semanticEffectTiming(read, effect, state) !== "after" &&
        !semanticBindingEffectFollowsCapture(
          binding,
          read,
          effect,
          state.parentsByNode,
        ) &&
        // Rebinding a freshly initialized local is activation-specific;
        // mutations to the referenced object may persist across calls.
        !(
          kind === "binding" &&
          semanticBindingEffectFollowsRead(
            binding,
            read,
            effect,
            state.parentsByNode,
          )
        ))
    )
      return true;
  return false;
};

/** Opaque eval may introduce an otherwise unbound name in a visible activation. */
const semanticOpaqueNameMayHaveChanged = (
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  binding?: JavaScriptSemanticBindingState,
): boolean => {
  if (state.opaqueEffects.byScope.size === 0) return false;
  const visible = new Set<string>();
  let node: t.Node | undefined = read;
  while (node !== undefined) {
    const scope = state.scopeByNode.get(node);
    if (scope !== undefined) {
      let current: typeof scope | undefined = scope;
      while (current !== undefined) {
        visible.add(current.scopeId);
        current =
          current.parentScopeId === null
            ? undefined
            : state.scopesById.get(current.parentScopeId);
      }
      break;
    }
    node = state.parentsByNode.get(node);
  }
  for (const [scopeId, sites] of state.opaqueEffects.byScope) {
    let scope = state.scopesById.get(scopeId);
    while (
      scope !== undefined &&
      scope.kind !== "function" &&
      scope.kind !== "program"
    )
      scope =
        scope.parentScopeId === null
          ? undefined
          : state.scopesById.get(scope.parentScopeId);
    if (
      scope !== undefined &&
      visible.has(scope.scopeId) &&
      (binding === undefined ||
        activation(binding.scopeId, state) !== scope.scopeId) &&
      sites.some(
        (effect) =>
          state.opaqueEffects.sloppySites.has(effect) &&
          (binding === undefined ||
            resolveSemanticBindingState(state, effect, binding.name)
              ?.bindingId === binding.bindingId) &&
          semanticEffectTiming(read, effect, state) !== "after" &&
          // A sloppy-eval name belongs to this activation, not a prior call.
          !semanticReadPrecedesEffectWithinActivation(
            read,
            effect,
            state.parentsByNode,
          ),
      )
    )
      return true;
  }
  return false;
};

/**
 * Non-writable, non-configurable global properties. Global code cannot replace
 * them; only a binding that shadows the name can.
 */
const IMMUTABLE_GLOBALS = new Set(["undefined", "NaN", "Infinity"]);

/**
 * Whether opaque code may have changed what an intrinsic global read observes.
 * A sloppy direct eval in an activation visible from `reference` may introduce
 * a binding for its root name; global code (`eval`, `Function`) that may run
 * before `observedAt` may replace a writable global or its prototype. Pass
 * `observedAt` when the intrinsic behavior is used later than the reference is
 * read, such as a method called on an instance constructed earlier.
 */
export const opaqueCodeMayChangeGlobalRead = (
  reference: t.Node,
  state: JavaScriptSemanticAnalysisState,
  root: string,
  observedAt: t.Node = reference,
): boolean =>
  semanticOpaqueNameMayHaveChanged(reference, state) ||
  (!IMMUTABLE_GLOBALS.has(root) &&
    semanticOpaqueGlobalMayHaveChanged(observedAt, state));

/**
 * Whether a source-visible ambient effect recorded anywhere in the source may
 * have changed `path` (a `global`, `import-meta` or module-tagged property
 * path): a write to it or to one of its prefixes. With `"contents"`, an escape
 * of it or of a prefix to code whose effects are not evaluated counts too.
 * The answer ignores timing, so it holds at every read site.
 */
export const ambientPathMayHaveChanged = (
  state: JavaScriptSemanticAnalysisState,
  path: JavaScriptSemanticPropertyPath,
  observes: "value" | "contents" = "value",
): boolean =>
  state.ambientWrites.covers(path) ||
  (observes === "contents" && state.ambientEscapes.covers(path));

/**
 * Whether a source-visible ambient write or escape recorded anywhere in the
 * source reaches `path`, one of its prefixes or any member below it. A reader
 * that depends on every member of an ambient object asks this. The answer
 * ignores timing, so it holds at every read site.
 */
export const ambientPathOrMemberMayHaveChanged = (
  state: JavaScriptSemanticAnalysisState,
  path: JavaScriptSemanticPropertyPath,
): boolean =>
  state.ambientWrites.touches(path) || state.ambientEscapes.touches(path);

/**
 * Whether an assignment to the ambient binding `name` is recorded anywhere in
 * the source. The answer ignores timing, so it holds at every read site.
 */
export const ambientBindingHasWrites = (
  state: JavaScriptSemanticAnalysisState,
  name: string,
): boolean => state.ambientBindingWrites.has(name);

/** Whether a recorded ambient effect's path is `target` or one of its prefixes. */
export const ambientEffectCovers = (
  effect: JavaScriptSemanticAnalysisState["ambientWriteEffects"][number],
  target: readonly string[],
): boolean =>
  effect.path.length <= target.length &&
  effect.path.every((key, index) =>
    semanticPropertyPathKeyMatches(key, target[index]!),
  );

/**
 * How a read proves that an effect runs after it. `"activation"` is
 * `semanticEffectTiming`, which orders effects within and across activations;
 * `"top-level"` orders only top-level statements of the program.
 */
export type SemanticEffectOrdering = "activation" | "top-level";

/**
 * Whether `effect` may run before `read` under `ordering`. Owners that index
 * their own effects (the ambient-write producer, RequireOrigin's
 * `module.require` writes) ask this; readers of recorded effects ask the
 * queries below.
 */
export const semanticEffectMayPrecede = (
  state: JavaScriptSemanticAnalysisState,
  read: t.Node,
  effect: t.Node | undefined,
  ordering: SemanticEffectOrdering = "activation",
): boolean =>
  ordering === "activation"
    ? semanticEffectTiming(read, effect, state) !== "after"
    : !semanticTopLevelEffectFollowsCapture(read, effect, state.parentsByNode);

/** Whether `effect` may run after `read`: it is not proven to run before. */
export const semanticEffectMayFollow = (
  state: JavaScriptSemanticAnalysisState,
  read: t.Node,
  effect: t.Node | undefined,
): boolean => semanticEffectTiming(read, effect, state) !== "before";

type AmbientEffect =
  JavaScriptSemanticAnalysisState["ambientWriteEffects"][number];

type MemberWrite = JavaScriptSemanticBindingState["memberWrites"][number];

/** Matching effects per queried path; the effect lists only grow, so their
 * lengths tell when a retained selection is stale. */
const ambientPathSelections = new WeakMap<
  JavaScriptSemanticAnalysisState,
  {
    writes: number;
    escapes: number;
    readonly byPath: Map<
      string,
      { readonly writes: AmbientEffect[]; readonly escapes: AmbientEffect[] }
    >;
  }
>();

const ambientPathEffects = (
  state: JavaScriptSemanticAnalysisState,
  path: readonly string[],
): { readonly writes: AmbientEffect[]; readonly escapes: AmbientEffect[] } => {
  let cache = ambientPathSelections.get(state);
  if (
    cache === undefined ||
    cache.writes !== state.ambientWriteEffects.length ||
    cache.escapes !== state.ambientEscapeEffects.length
  ) {
    cache = {
      writes: state.ambientWriteEffects.length,
      escapes: state.ambientEscapeEffects.length,
      byPath: new Map(),
    };
    ambientPathSelections.set(state, cache);
  }
  const key = JSON.stringify(path);
  let selected = cache.byPath.get(key);
  if (selected === undefined) {
    selected = {
      writes: state.ambientWriteEffects.filter((effect) =>
        ambientEffectCovers(effect, path),
      ),
      escapes: state.ambientEscapeEffects.filter((effect) =>
        ambientEffectCovers(effect, path),
      ),
    };
    cache.byPath.set(key, selected);
  }
  return selected;
};

/**
 * `mayObserve` for an ambient member path: whether a recorded write to `path`
 * or to one of its prefixes may run before `read`. With `"contents"`, an
 * escape of it to code whose effects are not evaluated counts too. Ambient
 * questions use activation timing only, so every reader of one ambient path
 * or name gets the same answer for the same read.
 */
export const ambientPathMayObserveAt = (
  state: JavaScriptSemanticAnalysisState,
  read: t.Node,
  path: readonly string[],
  observes: "value" | "contents" = "value",
): boolean => {
  const { writes, escapes } = ambientPathEffects(state, path);
  const mayPrecede = ({ node }: AmbientEffect): boolean =>
    semanticEffectMayPrecede(state, read, node);
  return (
    writes.some(mayPrecede) ||
    (observes === "contents" && escapes.some(mayPrecede))
  );
};

/**
 * `mayObserve` for an unbound name: whether a recorded assignment to the
 * ambient binding `name` may run before `read`. The loader and the origin of
 * one unbound `require` call, and the original global `process` object, ask
 * this one question.
 */
export const ambientBindingMayObserveWriteAt = (
  state: JavaScriptSemanticAnalysisState,
  read: t.Node,
  name: string,
): boolean =>
  (state.ambientBindingWrites.get(name) ?? []).some((write) =>
    semanticEffectMayPrecede(state, read, write),
  );

/**
 * A count that grows whenever an ambient write is recorded, or with
 * `"contents"` also an ambient escape: the effects `ambientPathMayObserveAt`
 * reads with the same argument. A cache that depends on them stores it and
 * recomputes when it differs.
 */
export const semanticAmbientEffectGeneration = (
  state: JavaScriptSemanticAnalysisState,
  observes: "value" | "contents" = "value",
): number =>
  state.ambientWriteEffects.length +
  (observes === "contents" ? state.ambientEscapeEffects.length : 0);

/**
 * A count that grows whenever a member write or escape is recorded on
 * `binding`. A cache that depends on the binding's member effects stores it
 * and recomputes when it differs.
 */
export const semanticBindingEffectGeneration = (
  binding: JavaScriptSemanticBindingState,
): number => binding.memberWrites.length + binding.escapedPaths.length;

/**
 * Recorded ambient writes to `global` paths, as intrinsic paths with
 * non-literal keys as null. A write recorded without a site is placed at the
 * program, so it may precede every read.
 */
export function* semanticAmbientIntrinsicWrites(
  state: JavaScriptSemanticAnalysisState,
): Generator<{
  readonly site: t.Node;
  readonly path: readonly (string | null)[];
}> {
  for (const { node, path } of state.ambientWriteEffects)
    if (path[0] === "global")
      yield {
        site: node ?? state.program,
        path: [
          "intrinsic",
          ...path
            .slice(1)
            .map((key) =>
              key === null || typeof key === "object" ? null : String(key),
            ),
        ],
      };
}

/** Sites of recorded ambient writes to `path` or to one of its prefixes. */
export const ambientPathWriteSites = (
  state: JavaScriptSemanticAnalysisState,
  path: readonly string[],
): readonly (t.Node | undefined)[] =>
  ambientPathEffects(state, path).writes.map(({ node }) => node);

/**
 * Whether a member write to `binding`'s object, or an escape of it, may run
 * before `read`. An escape whose site encloses `read` is the call that reads
 * it, so it does not count.
 */
export const bindingMemberEffectMayPrecede = (
  state: JavaScriptSemanticAnalysisState,
  binding: JavaScriptSemanticBindingState,
  read: t.Node,
): boolean =>
  binding.memberWrites.some(
    (effect) => semanticEffectTiming(read, effect.node, state) !== "after",
  ) ||
  binding.escapedPaths.some(
    (effect) =>
      effect.node !== undefined &&
      !(
        (effect.node.start ?? -1) <= (read.start ?? -1) &&
        (effect.node.end ?? -1) >= (read.end ?? -1)
      ) &&
      semanticEffectTiming(read, effect.node, state) !== "after",
  );

/**
 * Whether a recorded member write to `binding`'s object, or (with
 * `"member-effects"`) an escape of it, may run before every read `observedAt`
 * names for it. `observedAt` returns undefined for an effect the reader does
 * not ask about. A reader that asks only about writes skips the escapes, which
 * grow with every call through the binding.
 */
export const bindingMemberEffectMayPrecedeReads = (
  state: JavaScriptSemanticAnalysisState,
  binding: JavaScriptSemanticBindingState,
  observedAt: (
    kind: "member-write" | "escape",
    effect: MemberWrite,
  ) => readonly t.Node[] | undefined,
  ordering: SemanticEffectOrdering,
  observes: "member-writes" | "member-effects" = "member-effects",
): boolean => {
  for (const [kind, effects] of [
    ["member-write", binding.memberWrites],
    ["escape", observes === "member-effects" ? binding.escapedPaths : []],
  ] as const)
    for (const effect of effects) {
      const reads = observedAt(kind, effect);
      if (
        reads?.every((read) =>
          semanticEffectMayPrecede(state, read, effect.node, ordering),
        )
      )
        return true;
    }
  return false;
};

/**
 * Whether an assignment to `binding` recorded as a reference initializer
 * (a pattern or other non-ordinary write) may run before `read`.
 */
export const bindingAssignmentMayPrecede = (
  state: JavaScriptSemanticAnalysisState,
  binding: JavaScriptSemanticBindingState,
  read: t.Node,
): boolean =>
  binding.referenceInitializers.some(
    ({ assignment, node }) =>
      assignment && semanticEffectTiming(read, node, state) !== "after",
  );

/** The initializers of `binding` that may run before `read`. */
export const bindingInitializersMayPrecede = (
  state: JavaScriptSemanticAnalysisState,
  binding: JavaScriptSemanticBindingState,
  read: t.Node,
): JavaScriptSemanticBindingState["initializers"] =>
  binding.initializers.filter(
    ({ node }) => semanticEffectTiming(read, node, state) !== "after",
  );

/** Whether a recorded write to `<owner>.prototype` may run before `read`. */
export const prototypeMutationMayPrecede = (
  state: JavaScriptSemanticAnalysisState,
  owner: string,
  read: t.Node,
): boolean =>
  state.prototypeMutationSites.some(
    (effect) =>
      effect.owner === owner &&
      semanticEffectTiming(read, effect.node, state) !== "after",
  );

/**
 * Whether the `method` a read selects from `binding`'s object may have been
 * replaced before the read: by direct eval that can reach the object (a const
 * binding still exposes its properties), or by a write to the object, to
 * `method` or to its prototype, or by an escape of the object or its
 * prototype. Passing the method itself cannot replace its native [[Call]], and
 * the call that receives the object has already selected the method.
 * With `fresh`, each activation initializes a new instance. Writes to a
 * shared prototype can still reach later activations or replacement receivers.
 * `targets` filters only effects confined to the selected instance.
 */
export const bindingMethodMayHaveChanged = (
  binding: JavaScriptSemanticBindingState,
  method: string,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  {
    fresh,
    inherited,
    definingPrototypeDepth,
    isolatedNativeCloses,
    targets,
  }: {
    fresh: boolean;
    inherited: boolean;
    definingPrototypeDepth: number | undefined;
    isolatedNativeCloses: boolean;
    targets: (effect: JavaScriptSemanticMemberEffect) => boolean;
  },
): boolean => {
  // A prototype hop stays on the receiver chain. A constructor hop can
  // return to that chain through .prototype. A wildcard may do either.
  const reachesReceiver = (
    path: JavaScriptSemanticPropertyPath,
    length: number,
    escape = false,
  ) => {
    if (!inherited) return length === 0;
    let receiver = true;
    let constructor = false;
    for (let i = 0; i < length && (receiver || constructor); i++) {
      const key = path[i]!;
      const nextConstructor: boolean =
        receiver && semanticPropertyPathKeyMatches(key, "constructor");
      receiver =
        (receiver && semanticPropertyPathKeyMatches(key, "__proto__")) ||
        (constructor && semanticPropertyPathKeyMatches(key, "prototype"));
      constructor = nextConstructor;
    }
    // The native constructor itself also exposes its mutable prototype.
    return receiver || (escape && constructor);
  };
  const mayPrecede = (
    effect: t.Node | undefined,
    onInstance: boolean,
  ): boolean =>
    semanticEffectTiming(read, effect, state) !== "after" &&
    !(
      fresh &&
      onInstance &&
      effect !== undefined &&
      semanticReadPrecedesEffectWithinActivation(
        read,
        effect,
        state.parentsByNode,
      )
    );
  for (const effect of semanticOpaqueBindingEffects(
    binding,
    state,
    "reference",
  ))
    if (mayPrecede(effect, !inherited)) return true;
  const shadowedWrite = (path: JavaScriptSemanticPropertyPath): boolean =>
    definingPrototypeDepth !== undefined &&
    path.length - 1 > definingPrototypeDepth &&
    path.at(-1) === method &&
    path.slice(0, -1).every((key) => key === "__proto__");
  return (
    binding.memberWrites.some(
      (effect) =>
        (effect.path.length > 1 || targets(effect)) &&
        !shadowedWrite(effect.path) &&
        // A write changes a slot on its parent. Rebinding C.prototype
        // leaves the prototype of an already acquired receiver intact.
        (effect.path.length === 0 ||
          (reachesReceiver(effect.path, effect.path.length - 1) &&
            (semanticPropertyPathKeyMatches(effect.path.at(-1)!, method) ||
              (inherited &&
                semanticPropertyPathKeyMatches(
                  effect.path.at(-1)!,
                  "__proto__",
                ))))) &&
        mayPrecede(effect.node, effect.path.length <= 1),
    ) ||
    binding.escapedPaths.some((effect) => {
      // An opaque caller handed an instance can still reach its shared prototype.
      const instanceOnly = effect.path.length === 0 && !inherited;
      return (
        !(isolatedNativeCloses && effect.path.length === 0) &&
        (!instanceOnly || targets(effect)) &&
        reachesReceiver(effect.path, effect.path.length, true) &&
        effect.node !== state.parentsByNode.get(read) &&
        mayPrecede(effect.node, instanceOnly)
      );
    })
  );
};

/** Whether a member write to `binding`'s object is recorded. */
export const bindingHasMemberWrites = (
  binding: JavaScriptSemanticBindingState,
): boolean => binding.memberWrites.length > 0;

/** An opaque release can see the receiver only through its recorded effects. */
export const bindingEffectsConfinedToReceiverCalls = (
  binding: JavaScriptSemanticBindingState,
  matchesCall: (node: t.Node) => boolean,
): boolean =>
  !bindingHasMemberWrites(binding) &&
  binding.escapedPaths.every(
    ({ node, path }) =>
      path.length === 0 && node !== undefined && matchesCall(node),
  );

/**
 * Whether an escape of `binding`'s object is recorded at a site other than
 * `except`, the call a reader is already evaluating.
 */
export const bindingHasEscapesOutside = (
  binding: JavaScriptSemanticBindingState,
  except: t.Node | undefined,
): boolean => binding.escapedPaths.some((effect) => effect.node !== except);

/**
 * The nodes recorded member writes to `binding`'s object involve, in record
 * order: each write's site (undefined when it was recorded without one), then
 * the sources it assigned.
 */
export function* semanticMemberWriteNodes(
  binding: JavaScriptSemanticBindingState,
): Generator<t.Node | undefined> {
  for (const effect of binding.memberWrites) {
    yield effect.node;
    for (const source of effect.assignedSources ?? []) yield source.node;
  }
}

/** The sources recorded member writes assigned into `binding`'s object. */
export function* semanticMemberWriteSources(
  binding: JavaScriptSemanticBindingState,
): Generator<NonNullable<AmbientEffect["assignedSources"]>[number]> {
  for (const effect of binding.memberWrites)
    yield* effect.assignedSources ?? [];
}

const sameLiteralPrefix = (
  prefix: JavaScriptSemanticPropertyPath,
  path: SemanticAliasSelectionPath,
): boolean =>
  prefix.every(
    (key, index) =>
      key !== null &&
      typeof key !== "object" &&
      path[index] !== null &&
      typeof path[index] !== "object" &&
      String(key) === String(path[index]),
  );

/**
 * `mayObserve` for a projected member read of `binding`'s object at `path`:
 * the recorded member writes to `path` or to one of its prefixes that may run
 * before the read, in record order. `read.at(depth)` is where the selection
 * at `depth` is read; `read.capturedAt(depth)` is the copy that captured it,
 * when the read went through shallow copies, and `read.captured` are the
 * initializers the read's binding was captured from.
 *
 * Two replacement proofs stay here. A definite `=` write to a captured prefix
 * after the capture replaces the receiver, so writes through that prefix are
 * not observed when `freshReceiver` shows the new receiver is a fresh
 * allocation. The last definite `=` write to the selected path itself that
 * precedes the read is the replacement; `superseded` tells which earlier
 * writes it replaces.
 */
export const semanticBindingMemberWritesObservedAt = (
  state: JavaScriptSemanticAnalysisState,
  binding: JavaScriptSemanticBindingState,
  path: SemanticAliasSelectionPath,
  read: {
    readonly at: (depth: number) => t.Node;
    readonly capturedAt: ((depth: number) => t.Node | undefined) | undefined;
    readonly captured: readonly {
      readonly node: t.Node;
      readonly projection: unknown;
    }[];
  },
  freshReceiver: (
    root: t.Node,
    path: JavaScriptSemanticPropertyPath,
    state: JavaScriptSemanticAnalysisState,
  ) => boolean,
): {
  readonly writes: readonly MemberWrite[];
  /** Whether a definite replacement of the selected path precedes the read. */
  readonly replaced: boolean;
  readonly superseded: (effect: MemberWrite) => boolean;
  /** Whether an escape of `path` or a prefix may precede the read. */
  readonly escapeMayPrecede: () => boolean;
} => {
  const { at, capturedAt, captured } = read;
  // Only a definite assignment can replace an already captured receiver.
  // Select candidates once per query rather than rescanning every propagated
  // may-write for each matching effect.
  type PrefixReplacement = MemberWrite & {
    readonly receiverIdentity: "definite";
    readonly node: t.AssignmentExpression;
  };
  const prefixReplacements =
    capturedAt === undefined
      ? []
      : binding.memberWrites.filter(
          (replacement): replacement is PrefixReplacement =>
            replacement.receiverIdentity === "definite" &&
            t.isAssignmentExpression(replacement.node, { operator: "=" }) &&
            replacement.path.length < path.length,
        );
  const targetsReplacedPrefix = (effect: MemberWrite): boolean =>
    prefixReplacements.some((replacement) => {
      const capture = capturedAt!(replacement.path.length);
      const receiverAt = effect.receiverAt ?? effect.node;
      return (
        capture !== undefined &&
        receiverAt !== undefined &&
        replacement.path.length < effect.path.length &&
        sameLiteralPrefix(replacement.path, effect.path) &&
        semanticTopLevelEffectFollowsCapture(
          capture,
          replacement.node,
          state.parentsByNode,
        ) &&
        semanticDefiniteEffectPrecedesReference(
          replacement.node,
          receiverAt,
          state.parentsByNode,
        ) &&
        freshReceiver(
          replacement.node.right,
          effect.path.slice(replacement.path.length, -1),
          state,
        )
      );
    });
  // Every condition is a pure query. Test the selected path first: it is the
  // cheapest and rejects most records of a binding with many member paths.
  const matches = (effect: MemberWrite) =>
    semanticEffectPathMatches(effect.path, path) &&
    (effect.receiverInitializers === undefined ||
      effect.receiverInitializers.length === 0 ||
      captured.length === 0 ||
      effect.receiverInitializers.some((receiver) =>
        captured.some(
          (source) =>
            source.node === receiver.node &&
            JSON.stringify(source.projection) ===
              JSON.stringify(receiver.projection),
        ),
      )) &&
    semanticEffectTiming(at(effect.path.length), effect.node, state) !==
      "after" &&
    !targetsReplacedPrefix(effect);
  const writes = semanticEffectPathCandidates(
    binding.memberWrites,
    path,
  ).filter(matches);
  let replacement: MemberWrite | undefined;
  for (const effect of writes) {
    if (
      effect.receiverIdentity === "definite" &&
      t.isAssignmentExpression(effect.node, { operator: "=" }) &&
      sameLiteralPrefix(effect.path, path) &&
      semanticDefiniteEffectPrecedesReference(
        effect.node,
        at(effect.path.length),
        state.parentsByNode,
      ) &&
      (replacement === undefined ||
        semanticDefiniteEffectPrecedesReference(
          replacement.node!,
          effect.node,
          state.parentsByNode,
        ) ||
        (replacement.node === effect.node &&
          (replacement.assignedSources?.[0]?.target?.start ?? -1) <
            (effect.assignedSources?.[0]?.target?.start ?? -1)))
    )
      replacement = effect;
  }
  const superseded = (effect: MemberWrite) =>
    replacement !== undefined &&
    effect.node !== undefined &&
    effect !== replacement &&
    (semanticEffectTiming(replacement.node!, effect.node, state) === "before" ||
      (effect.node === replacement.node &&
        (effect.assignedSources?.[0]?.target?.start ?? -1) <
          (replacement.assignedSources?.[0]?.target?.start ?? -1)));
  return {
    writes,
    replaced: replacement !== undefined,
    superseded,
    escapeMayPrecede: () =>
      semanticSomeEffectPathCandidate(
        binding.escapedPaths,
        path,
        (effect) => matches(effect) && !superseded(effect),
      ),
  };
};

/** Declaration assignability is independent of observed explicit writes. */
const semanticBindingCanBeRebound = (
  binding: JavaScriptSemanticBindingState,
): boolean =>
  binding.mutable ||
  (binding.definitions.some(
    ({ kind }) => kind === "function" || kind === "class",
  ) &&
    binding.initializers.some(
      ({ node }) => t.isFunctionDeclaration(node) || t.isClassDeclaration(node),
    ));

/**
 * Whether opaque code (a direct eval visible to the binding) may have rebound
 * it. With a read, only effects that may precede that read count, and a sloppy
 * direct eval may also have introduced a shadowing name visible from it.
 * Without one, any visible direct eval counts.
 */
export const opaqueCodeMayRebindBinding = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  read?: t.Node,
): boolean =>
  (semanticBindingCanBeRebound(binding) &&
    semanticBindingMayHaveOpaqueEffect(binding, state, read)) ||
  (read !== undefined &&
    semanticOpaqueNameMayHaveChanged(read, state, binding));

/**
 * Whether opaque code may have mutated the object a binding references after
 * it was captured; objects stay reachable through aliases where the name is
 * shadowed or out of scope.
 */
const opaqueCodeMayReachBindingReference = (
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  capturePoint: t.Node | undefined,
): boolean =>
  semanticBindingMayHaveOpaqueEffect(binding, state, capturePoint, "reference");

/**
 * The value of `binding`'s reference as a read captured at `capturePoint`
 * observes it, after the recorded effects that may precede the capture:
 * member writes invalidate their paths, escapes invalidate the escaped object
 * references, and a direct eval that may reach the reference makes an object
 * or array unknown. Without a capture point, every recorded effect counts.
 */
export const applySemanticBindingReferenceEffects = (
  value: JavaScriptSemanticValue,
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
  capturePoint: t.Node | undefined,
): JavaScriptSemanticValue => {
  let projected = invalidateSemanticMutationPaths(
    value,
    binding.memberWrites
      .filter(
        ({ node }) =>
          capturePoint === undefined ||
          node === undefined ||
          !semanticBindingEffectFollowsCapture(
            binding,
            capturePoint,
            node,
            state.parentsByNode,
          ),
      )
      .map(({ path }) => path),
  );
  for (const escape of binding.escapedPaths) {
    // Escapes only invalidate object references; other lattice values survive.
    if (projected.status !== "object" && projected.status !== "array") break;
    if (
      capturePoint !== undefined &&
      semanticEscapeFollowsCapture(
        binding,
        capturePoint,
        escape.node,
        state.parentsByNode,
      )
    )
      continue;
    projected = invalidateSemanticEscapedPath(projected, escape.path);
  }
  if (
    (projected.status === "object" || projected.status === "array") &&
    opaqueCodeMayReachBindingReference(binding, state, capturePoint)
  )
    projected = {
      status: "unknown",
      reason: "Direct eval may have mutated this object reference.",
    };
  return projected;
};

/**
 * Opaque sites that may affect a binding, for a report of every effect: direct
 * evals that may rebind it when its declaration is assignable, then every
 * direct eval that may reach the object it references (an escape of its whole
 * value). Timing and path proofs stay with the caller's effect report.
 */
function* semanticOpaqueReferenceEffects(
  binding: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): Generator<{
  readonly kind: "binding-write" | "escape";
  readonly node: t.CallExpression;
}> {
  if (semanticBindingCanBeRebound(binding))
    for (const node of semanticOpaqueBindingEffects(binding, state))
      yield { kind: "binding-write", node };
  for (const node of semanticOpaqueBindingEffects(binding, state, "reference"))
    yield { kind: "escape", node };
}

const activation = (
  scopeId: string,
  state: JavaScriptSemanticAnalysisState,
): string => {
  let scope = state.scopesById.get(scopeId);
  while (
    scope !== undefined &&
    scope.kind !== "function" &&
    scope.kind !== "program" &&
    scope.parentScopeId !== null
  )
    scope = state.scopesById.get(scope.parentScopeId);
  return scope?.scopeId ?? scopeId;
};

const strictEval = (
  site: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  for (
    let node: t.Node | undefined = site;
    node !== undefined;
    node = state.parentsByNode.get(node)
  ) {
    if (
      t.isClass(node) ||
      (t.isProgram(node) && javaScriptProgramStrictness(node) === "strict")
    )
      return true;
    const directives =
      t.isFunction(node) && t.isBlockStatement(node.body)
        ? node.body.directives
        : [];
    if (directives.some(({ value }) => value.value === "use strict"))
      return true;
  }
  return false;
};

/** Ambient root paths a global reference may alias; the ambient-write owner
 * resolves them, so the effect log takes the resolver from its caller. */
export type SemanticAmbientRootPaths = (
  root: t.Node,
) => readonly (readonly (string | null)[])[];

/** One owner projects source-site effects for complete reports or early exit. */
const visitSemanticReferenceEffectsAtSite = (
  state: JavaScriptSemanticAnalysisState,
  ambientPaths: SemanticAmbientRootPaths,
  site: t.Node,
  referenceNode: t.Node,
  visit: (
    effect: JavaScriptSemanticReferenceEffectsAtSite["effects"][number],
  ) => boolean,
  requestedPath?: JavaScriptSemanticPropertyPath,
  effectTiming: typeof semanticEffectTiming = semanticEffectTiming,
): Omit<JavaScriptSemanticReferenceEffectsAtSite, "effects"> => {
  const { root, path: inferredPath } = semanticReferenceRoot(referenceNode);
  const memberEffectsIndexed = state.memberMutationFactsComplete;
  if (!t.isIdentifier(root))
    return {
      bindingId: null,
      resolution: "unknown",
      memberEffectsIndexed,
    };
  const lookup = semanticBindingLookupAt(state, root, root.name);
  const binding = "binding" in lookup ? lookup.binding : undefined;
  const blocked = lookup.kind !== "binding" && lookup.kind !== "ambient";
  const resolution =
    lookup.kind === "binding" ? "resolved" : blocked ? "unknown" : "unbound";
  const path = requestedPath ?? inferredPath;
  const metadata: Omit<JavaScriptSemanticReferenceEffectsAtSite, "effects"> = {
    bindingId: binding?.bindingId ?? null,
    resolution,
    memberEffectsIndexed,
  };
  const retain = (
    kind: JavaScriptSemanticReferenceEffectsAtSite["effects"][number]["kind"],
    node: t.Node | undefined,
    effectPath?: JavaScriptSemanticPropertyPath,
  ): boolean => {
    if (effectPath !== undefined && !semanticPathsOverlap(path, effectPath))
      return true;
    return visit({
      kind,
      ...(effectPath === undefined ? {} : { path: effectPath }),
      timing: effectTiming(site, node, state),
    });
  };
  if (binding !== undefined) {
    for (const { kind, node } of semanticOpaqueReferenceEffects(binding, state))
      if (!retain(kind, node, kind === "escape" ? [] : undefined))
        return metadata;
    for (const node of state.bindingWrites.get(binding.bindingId) ?? [])
      if (!retain("binding-write", node)) return metadata;
    // The mutation producer also queries its growing facts during convergence.
    // Completion stays explicit in metadata; callers cannot infer readiness.
    for (const effect of binding.memberWrites)
      if (!retain("member-write", effect.node, effect.path)) return metadata;
    for (const effect of binding.escapedPaths)
      if (!retain("escape", effect.node, effect.path)) return metadata;
  } else if (lookup.kind === "ambient" || lookup.kind === "uncertain-ambient") {
    for (const node of state.ambientBindingWrites.get(root.name) ?? [])
      if (!retain("ambient-write", node)) return metadata;
    const ambientRoots = ambientPaths(root);
    for (const ambientRoot of ambientRoots) {
      const selectedPath = [...ambientRoot, ...path];
      for (const [kind, effects] of [
        ["member-write", state.ambientWriteEffects],
        ["escape", state.ambientEscapeEffects],
      ] as const)
        for (const effect of effects)
          if (
            semanticPathsOverlap(selectedPath, effect.path) &&
            !retain(kind, effect.node, effect.path.slice(ambientRoot.length))
          )
            return metadata;
    }
  }
  return metadata;
};

/** Query current producer facts; public consumers additionally require completion. */
export const semanticReferenceEffectsMayHaveChanged = (
  state: JavaScriptSemanticAnalysisState,
  ambientPaths: SemanticAmbientRootPaths,
  site: t.Node,
  referenceNode: t.Node,
  propertyPath?: JavaScriptSemanticPropertyPath,
): boolean => {
  let changed = false;
  const metadata = visitSemanticReferenceEffectsAtSite(
    state,
    ambientPaths,
    site,
    referenceNode,
    (effect) => {
      changed = effect.timing !== "after";
      return !changed;
    },
    propertyPath,
  );
  return metadata.resolution !== "resolved" || changed;
};

/**
 * `mayObserve(read, target, path)` (ADR decision 2): whether reading `target`
 * at `path` (default: the member path `target` spells) at `read` may observe
 * a recorded effect. Before the member-mutation phase completes, every read
 * may observe one (decision 4).
 */
export const semanticReadMayObserveEffect = (
  state: JavaScriptSemanticAnalysisState,
  ambientPaths: SemanticAmbientRootPaths,
  read: t.Node,
  target: t.Node,
  path?: JavaScriptSemanticPropertyPath,
): boolean =>
  !state.memberMutationFactsComplete ||
  semanticReferenceEffectsMayHaveChanged(
    state,
    ambientPaths,
    read,
    target,
    path,
  );

/** Preserve the complete diagnostic contract for consumers needing every effect. */
export const semanticReferenceEffectsAtSite = (
  state: JavaScriptSemanticAnalysisState,
  ambientPaths: SemanticAmbientRootPaths,
  site: t.Node,
  referenceNode: t.Node,
  requestedPath?: JavaScriptSemanticPropertyPath,
  effectTiming: typeof semanticEffectTiming = semanticEffectTiming,
): JavaScriptSemanticReferenceEffectsAtSite => {
  const effects: JavaScriptSemanticReferenceEffectsAtSite["effects"][number][] =
    [];
  const metadata = visitSemanticReferenceEffectsAtSite(
    state,
    ambientPaths,
    site,
    referenceNode,
    (effect) => {
      effects.push(effect);
      return true;
    },
    requestedPath,
    effectTiming,
  );
  return { ...metadata, effects };
};

export const semanticReferenceRoot = (
  node: t.Node,
): { readonly root: t.Node; readonly path: JavaScriptSemanticPropertyPath } => {
  const path: (string | number | null)[] = [];
  let current = unwrapJavaScriptExpression(node).node;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    const key = semanticStaticPropertyKey(current.property, current.computed);
    path.unshift(key ?? null);
    current = unwrapJavaScriptExpression(current.object).node;
  }
  return { root: current, path };
};

const semanticPathsOverlap = (
  left: JavaScriptSemanticPropertyPath,
  right: JavaScriptSemanticPropertyPath,
): boolean => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const leftKey = left[index];
    const rightKey = right[index];
    if (leftKey === undefined || rightKey === undefined) return true;
    const leftMatchesRight =
      typeof rightKey === "string" || typeof rightKey === "number"
        ? semanticPropertyPathKeyMatches(leftKey, String(rightKey))
        : true;
    const rightMatchesLeft =
      typeof leftKey === "string" || typeof leftKey === "number"
        ? semanticPropertyPathKeyMatches(rightKey, String(leftKey))
        : true;
    if (!leftMatchesRight && !rightMatchesLeft) return false;
  }
  return true;
};
