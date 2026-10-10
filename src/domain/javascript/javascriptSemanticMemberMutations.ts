import * as t from "@babel/types";

import {
  resolveSemanticBindingState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  clearSemanticPrimitiveBindingValues,
  evaluateSemanticBinding,
  evaluateSemanticExpression,
} from "./javascriptSemanticValues.js";
import {
  semanticContainer,
  semanticSlotAtPath,
} from "./javascriptSemanticSlots.js";
import { semanticIterationSources } from "./javascriptSemanticIterationSources.js";
import { semanticCallableResultExpressions } from "./javascriptSemanticCallableResults.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import { semanticMutationInitializers } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticArrayIndex,
  SemanticPropertyPathCoverage,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

type PropertyPath = JavaScriptSemanticPropertyPath;
type ValueEffect = "write" | "escape";

/** Preserve uncertainty from property writes and references exposed to calls, yielding during traversal and fixpoint iteration. */
export function* collectSemanticMemberMutationsSteps(
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): Generator<void, void> {
  const parents = state.parentsByNode;
  const normalizePath = observableMutationPaths(state);
  const returnedReferences = createSemanticReturnedReferences(state);
  const recordedEffects = new Set<string>();
  const selections = new Map<string, readonly string[]>();
  const coveringPaths = new Map<string, SemanticPropertyPathCoverage>();
  let arrayIterationUnknown = false;
  const pendingReferences: {
    readonly initializer: JavaScriptSemanticBindingState["referenceInitializers"][number];
    readonly path: PropertyPath;
    readonly bindings: ReadonlySet<string>;
    readonly effect: ValueEffect;
    readonly mutation?: t.Node;
    readonly originAt: t.Node | undefined;
  }[] = [];
  const iterableReferences: IterableReference[] = [];
  const iterableReferenceKeys = new WeakMap<t.Node, Set<string>>();
  const deferIterable = (reference: IterableReference): void => {
    const keys = iterableReferenceKeys.get(reference.node) ?? new Set<string>();
    const key = JSON.stringify([
      reference.projection,
      reference.path,
      reference.fallbackPath,
      reference.effect,
      reference.mutation?.start,
      reference.mutation?.end,
      reference.originAt?.start,
      reference.originAt?.end,
      reference.iterationOnly,
      reference.requiredSources?.map((source) => [
        source.node.start,
        source.node.end,
        source.projection,
      ]),
      reference.fallbackSources?.map((source) => [
        source.node.start,
        source.node.end,
        source.projection,
      ]),
      [...reference.bindings].sort(compareUnicodeCodePoints),
    ]);
    if (keys.has(key)) return;
    keys.add(key);
    iterableReferenceKeys.set(reference.node, keys);
    iterableReferences.push(reference);
  };
  const markValue = (
    node: t.Node,
    path: PropertyPath,
    bindings: ReadonlySet<string>,
    effect: ValueEffect = "write",
    mutation?: t.Node,
    originAt: t.Node | undefined = mutation,
  ): void => {
    const pending = [{ node, path, bindings, originAt }];
    // Visit shallower alias traversals first so their exact prefixes suppress
    // longer loop paths before those paths enumerate every assignment order.
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const current = pending[cursor];
      if (current === undefined) break;
      const expression = unwrapJavaScriptExpression(current.node).node;
      if (t.isIdentifier(expression)) {
        const binding = resolveSemanticBindingState(
          state,
          expression,
          expression.name,
        );
        if (binding === undefined) {
          if (
            (expression.name === "Array" &&
              (current.path[0] === "prototype" || current.path[0] === null)) ||
            (["globalThis", "global", "window", "self"].includes(
              expression.name,
            ) &&
              (current.path[0] === "Array" || current.path[0] === null) &&
              (current.path[1] === "prototype" || current.path[1] === null))
          )
            arrayIterationUnknown = true;
          continue;
        }
        // An alias restored from a saved reference can revisit the same binding
        // at an earlier capture. Only a repeated lifetime closes a cycle.
        const lifetime = JSON.stringify([
          binding.bindingId,
          current.originAt?.start,
          current.originAt?.end,
        ]);
        if (current.bindings.has(lifetime)) continue;
        // Union compatible copied-slot selections at each binding. Carrying every
        // combination of exclusions through branch diamonds is exponential.
        // Preserve paths that can change observed slots or Array prototype
        // effects; canonicalize suffixes that cannot distinguish lattice facts.
        let path = normalizePath(binding.bindingId, current.path, effect);
        if (path === null) continue;
        const selectorIndex = path.findIndex(
          (key) => key !== null && typeof key === "object",
        );
        const selector = path[selectorIndex];
        if (selector !== null && typeof selector === "object") {
          const selectionIdentity = JSON.stringify([
            binding.bindingId,
            effect,
            path.map((key, index) =>
              index === selectorIndex
                ? { startIndex: selector.startIndex }
                : key,
            ),
            mutation?.start,
            mutation?.end,
            current.originAt?.start,
            current.originAt?.end,
          ]);
          const previous = selections.get(selectionIdentity);
          const excludedKeys =
            previous === undefined
              ? selector.excludedKeys
              : previous.filter((key) => selector.excludedKeys.includes(key));
          if (previous !== undefined && excludedKeys.length === previous.length)
            continue;
          selections.set(selectionIdentity, excludedKeys);
          path = path.map((key, index) =>
            index === selectorIndex ? { ...selector, excludedKeys } : key,
          );
        }
        // Keep an antichain of exact paths. Widening distinct member keys would
        // also invalidate unrelated siblings that never reach this effect.
        const pathState = JSON.stringify([
          binding.bindingId,
          effect,
          // Short writes stop at owned literal slots, whereas longer writes
          // reach shared children. Only equal-depth writes cover one another.
          effect === "write" ? path.length : null,
          mutation?.start,
          mutation?.end,
          current.originAt?.start,
          current.originAt?.end,
        ]);
        let covering = coveringPaths.get(pathState);
        if (covering === undefined) {
          covering = new SemanticPropertyPathCoverage();
          coveringPaths.set(pathState, covering);
        }
        if (!covering.retain(path)) continue;
        const identity = JSON.stringify([
          binding.bindingId,
          effect,
          path,
          mutation?.start,
          mutation?.end,
          current.originAt?.start,
          current.originAt?.end,
        ]);
        if (recordedEffects.has(identity)) continue;
        // A recorded write invalidates the binding to a non-primitive value, so
        // only its first write can target a primitive. Re-evaluating it would
        // replay every earlier write and make repeated writes superlinear.
        const value =
          effect === "write" && binding.mutatedPaths.length === 0
            ? evaluateSemanticBinding(binding, state)
            : undefined;
        const primitiveWrite =
          value?.status === "literal" || value?.status === "union";
        recordedEffects.add(identity);
        const nested = new Set([...current.bindings, lifetime]);
        const origins =
          current.originAt === undefined
            ? binding
            : semanticMutationInitializers(binding, current.originAt, parents);
        if (!primitiveWrite) {
          if (effect === "escape")
            binding.escapedPaths.push({ path, node: mutation });
          else binding.mutatedPaths.push(path);
          clearSemanticPrimitiveBindingValues(state);
          for (const initializer of origins.initializers)
            pending.push({
              node: initializer.node,
              path: [...initializer.projection, ...path],
              bindings: nested,
              originAt: initializer.node,
            });
        }
        for (const initializer of origins.referenceInitializers) {
          const copiedPath = copiedReferencePath(initializer, path, effect);
          if (copiedPath === null) continue;
          pendingReferences.push({
            initializer,
            path: copiedPath,
            bindings: nested,
            effect,
            originAt: initializer.node,
            ...(mutation === undefined ? {} : { mutation }),
          });
        }
      } else if (
        t.isMemberExpression(expression) ||
        t.isOptionalMemberExpression(expression)
      ) {
        pending.push({
          node: expression.object,
          path: [
            semanticStaticPropertyKey(expression.property, expression.computed),
            ...current.path,
          ],
          bindings: current.bindings,
          originAt: current.originAt,
        });
      } else {
        for (const value of effect === "escape"
          ? escapedReferenceLeaves(expression, current.path)
          : expandedValues(expression, current.path, effect)) {
          if (value.iterableFallbackPath !== undefined)
            deferIterable({
              node: value.node,
              projection: [],
              path: value.path,
              fallbackPath: value.iterableFallbackPath,
              bindings: current.bindings,
              effect,
              originAt: current.originAt,
              ...(mutation === undefined ? {} : { mutation }),
            });
          else
            pending.push({
              ...value,
              bindings: current.bindings,
              originAt: current.originAt,
            });
        }
      }
    }
  };
  const markEscaped = (
    node: t.Node,
    mutation: t.Node,
    path: PropertyPath = [],
  ): void => markValue(node, path, new Set(), "escape", mutation);
  function expandedValues(
    expression: t.Node,
    path: PropertyPath,
    effect: ValueEffect,
  ): readonly ReferencedValue[] {
    if (
      t.isArrayExpression(expression) &&
      ((path[0] === "__proto__" && (effect === "escape" || path.length > 1)) ||
        (path[0] === "constructor" && path[1] === "prototype"))
    )
      arrayIterationUnknown = true;
    return referencedValues(expression, path, effect);
  }
  // Expanding a value below its references depends only on syntax, not on the
  // escape site. Escaping an object reaches every method's results, so
  // re-expanding it at each call through that object made N calls over N
  // methods quadratic. Identifiers that resolve to the same binding and path
  // are processed identically, so one stands for all of them.
  const escapedLeaves = new WeakMap<
    t.Node,
    Map<string, readonly ReferencedValue[]>
  >();
  function escapedReferenceLeaves(
    root: t.Node,
    rootPath: PropertyPath,
  ): readonly ReferencedValue[] {
    // Parser recovery can leave an argument hole, which expands to nothing.
    if (!t.isNode(root)) return [];
    const rootKey = JSON.stringify(rootPath);
    const cached = escapedLeaves.get(root)?.get(rootKey);
    if (cached !== undefined) return cached;
    const leaves: ReferencedValue[] = [];
    const leafIdentities = new Set<string>();
    const expanded = new WeakMap<t.Node, Set<string>>();
    const pending = [...expandedValues(root, rootPath, "escape")];
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const value = pending[cursor];
      if (value === undefined) break;
      const node = unwrapJavaScriptExpression(value.node).node;
      if (!t.isNode(node)) continue;
      const pathKey = JSON.stringify(value.path);
      if (t.isIdentifier(node) && value.iterableFallbackPath === undefined) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        const identity = JSON.stringify([
          binding === undefined ? null : binding.bindingId,
          binding === undefined ? node.name : null,
          pathKey,
        ]);
        if (leafIdentities.has(identity)) continue;
        leafIdentities.add(identity);
        leaves.push(value);
      } else if (
        value.iterableFallbackPath !== undefined ||
        t.isIdentifier(node) ||
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      )
        leaves.push(value);
      else {
        const paths = expanded.get(node) ?? new Set<string>();
        if (paths.has(pathKey)) continue;
        paths.add(pathKey);
        expanded.set(node, paths);
        for (const reference of expandedValues(node, value.path, "escape"))
          pending.push(reference);
      }
    }
    const byPath = escapedLeaves.get(root) ?? new Map();
    byPath.set(rootKey, leaves);
    escapedLeaves.set(root, byPath);
    return leaves;
  }
  const markReceiver = (callee: t.Node, mutation: t.Node): void => {
    const expression = unwrapJavaScriptExpression(callee).node;
    if (
      t.isMemberExpression(expression) ||
      t.isOptionalMemberExpression(expression)
    )
      markEscaped(expression.object, mutation);
  };
  const markTarget = (node: t.Node, mutation: t.Node): void => {
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
      markValue(
        node.object,
        [semanticStaticPropertyKey(node.property, node.computed)],
        new Set(),
        "write",
        mutation,
      );
    else if (t.isRestElement(node)) markTarget(node.argument, mutation);
    else if (t.isAssignmentPattern(node)) markTarget(node.left, mutation);
    else if (t.isArrayPattern(node)) {
      for (const element of node.elements)
        if (element !== null) markTarget(element, mutation);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties)
        markTarget(
          t.isRestElement(property) ? property.argument : property.value,
          mutation,
        );
    }
  };
  yield* traverseJavaScriptAstSteps(program, {
    enter: (node, parent) => {
      for (const source of semanticIterationSources(node, parent))
        deferIterable({
          ...source,
          path: source.projection,
          fallbackPath: source.projection,
          bindings: new Set(),
          effect: "escape",
          originAt: source.mutation,
          iterationOnly: source.kind === "iteration",
        });
      if (t.isAssignmentExpression(node)) markTarget(node.left, node);
      else if (t.isUpdateExpression(node)) markTarget(node.argument, node);
      else if (t.isUnaryExpression(node, { operator: "delete" }))
        markTarget(node.argument, node);
      else if (t.isForOfStatement(node) || t.isForInStatement(node))
        markTarget(node.left, node);
      else if (
        t.isCallExpression(node) ||
        t.isOptionalCallExpression(node) ||
        t.isNewExpression(node)
      ) {
        for (const source of returnedReferences(node.callee))
          markEscaped(source.node, node, source.projection);
        for (const argument of node.arguments)
          if (t.isSpreadElement(argument))
            deferIterable({
              node: argument.argument,
              projection: [],
              path: [null],
              fallbackPath: [],
              bindings: new Set(),
              effect: "escape",
              mutation: node,
              originAt: node,
            });
          else markEscaped(argument, node);
        // Constructing a member does not pass its container as `this`.
        if (!t.isNewExpression(node)) markReceiver(node.callee, node);
      } else if (t.isTaggedTemplateExpression(node)) {
        markReceiver(node.tag, node);
        for (const expression of node.quasi.expressions)
          markEscaped(expression, node);
      }
    },
  });
  // A later effect can make a previously defined destructuring source uncertain.
  // Reconsider defaults and iterable origins until their effects are stable.
  while (pendingReferences.length > 0 || iterableReferences.length > 0) {
    const effectsBefore = recordedEffects.size;
    const iterablesBefore = iterableReferences.length;
    const iterationBefore: boolean = arrayIterationUnknown;
    for (const [index, reference] of pendingReferences.splice(0).entries()) {
      if (index % 64 === 0) yield;
      const { initializer } = reference;
      if (referenceSourcesInactive(initializer, state))
        pendingReferences.push(reference);
      else if (t.isForOfStatement(initializer.node))
        deferIterable({
          node: initializer.node.right,
          projection: [],
          path: [null, ...reference.path],
          fallbackPath: [],
          bindings: reference.bindings,
          effect: reference.effect,
          originAt: initializer.node,
          ...(reference.mutation === undefined
            ? {}
            : { mutation: reference.mutation }),
        });
      else if (
        initializer.copyKind === "array-rest" &&
        initializer.copyProjectionOffset !== undefined
      ) {
        const offset = initializer.copyProjectionOffset;
        const projection = initializer.projection.slice(0, offset);
        deferIterable({
          node: initializer.node,
          projection,
          path: reference.path,
          fallbackPath: projection,
          bindings: reference.bindings,
          effect: reference.effect,
          originAt: reference.originAt,
          ...(reference.mutation === undefined
            ? {}
            : { mutation: reference.mutation }),
        });
      } else
        markValue(
          initializer.node,
          reference.path,
          reference.bindings,
          reference.effect,
          reference.mutation,
          reference.originAt,
        );
    }
    for (const [index, reference] of [...iterableReferences].entries()) {
      if (index % 64 === 0) yield;
      if (referenceSourcesInactive(reference, state)) continue;
      if (reference.iterationOnly) {
        const expanded = expandedIterationReferences(reference, state);
        if (expanded !== null) {
          for (const selected of expanded) deferIterable(selected);
          continue;
        }
      }
      const slot = selectedReferenceSlot(reference, state);
      // Custom iteration can yield the iterable itself as well as any child.
      // Treat its root as escaped, including writes through yielded references.
      const knownArray =
        !arrayIterationUnknown &&
        slot?.value.status === "array" &&
        slot.value.items.every(
          (item) => semanticArrayIndex(item.name) !== null,
        );
      if (knownArray && reference.iterationOnly) continue;
      markValue(
        reference.node,
        knownArray ? reference.path : reference.fallbackPath,
        reference.bindings,
        knownArray ? reference.effect : "escape",
        reference.mutation,
        reference.originAt,
      );
    }
    if (
      recordedEffects.size === effectsBefore &&
      iterableReferences.length === iterablesBefore &&
      arrayIterationUnknown === iterationBefore
    )
      break;
  }
  // Gathering effects can evaluate a primitive projection before its object
  // escapes. Final values must use the completed mutation state.
  clearSemanticPrimitiveBindingValues(state);
}

interface ReferencedValue {
  readonly node: t.Node;
  readonly path: PropertyPath;
  readonly iterableFallbackPath?: PropertyPath;
}

interface IterableReference extends ReferencedValue {
  readonly projection: PropertyPath;
  readonly fallbackPath: PropertyPath;
  readonly bindings: ReadonlySet<string>;
  readonly effect: ValueEffect;
  readonly mutation?: t.Node;
  readonly originAt: t.Node | undefined;
  readonly iterationOnly?: boolean;
  readonly requiredSources?: readonly {
    readonly node: t.Node;
    readonly projection: PropertyPath;
  }[];
  readonly fallbackSources?: readonly {
    readonly node: t.Node;
    readonly projection: PropertyPath;
  }[];
}

const referenceSourcesInactive = (
  reference: Pick<IterableReference, "requiredSources" | "fallbackSources">,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  reference.requiredSources?.some(
    (source) =>
      selectedReferenceSlot(source, state, source.node)?.presence === "absent",
  ) === true ||
  reference.fallbackSources?.some((source) => {
    // Selection precedes effects through the chosen reference. A later escape
    // cannot make a fallback that was excluded at destructuring reachable.
    const slot = selectedReferenceSlot(source, state, source.node);
    return (
      slot?.presence === "present" &&
      (slot.value.status === "literal" ||
        slot.value.status === "union" ||
        slot.value.status === "object" ||
        slot.value.status === "array")
    );
  }) === true;

const expandedIterationReferences = (
  reference: IterableReference,
  state: JavaScriptSemanticAnalysisState,
): readonly IterableReference[] | null => {
  if (!t.isForOfStatement(reference.mutation)) return null;
  const iterable = reference.mutation.right;
  // Expand only the loop's yielded-item selector. Enumerating dynamic property
  // selections would multiply paths through shared object aliases.
  const source = [
    reference,
    ...(reference.requiredSources ?? []),
    ...(reference.fallbackSources ?? []),
  ].find((source) => source.node === iterable && source.projection[0] === null);
  if (source === undefined) return null;
  const slot = selectedReferenceSlot({ node: iterable, projection: [] }, state);
  const container = slot === undefined ? null : semanticContainer(slot.value);
  if (container?.coverage.status !== "complete") return null;
  const select = (
    candidate: { readonly node: t.Node; readonly projection: PropertyPath },
    name: string,
  ) => ({
    ...candidate,
    projection:
      candidate.node === iterable && candidate.projection[0] === null
        ? [name, ...candidate.projection.slice(1)]
        : candidate.projection,
  });
  return container.slots.map((slot) => {
    const { projection } = select(reference, slot.name);
    return {
      ...reference,
      projection,
      path: projection,
      fallbackPath: projection,
      ...(reference.requiredSources === undefined
        ? {}
        : {
            requiredSources: reference.requiredSources.map((source) =>
              select(source, slot.name),
            ),
          }),
      ...(reference.fallbackSources === undefined
        ? {}
        : {
            fallbackSources: reference.fallbackSources.map((source) =>
              select(source, slot.name),
            ),
          }),
    };
  });
};

const referencedValues = (
  node: t.Node,
  path: PropertyPath,
  effect: ValueEffect,
): readonly ReferencedValue[] => {
  if (effect === "escape" && t.isFunction(node))
    return semanticCallableResultExpressions(node).flatMap(
      ({ node, delegated }) =>
        node === null ? [] : [{ node, path: delegated ? [null] : [] }],
    );
  // An initializer owns its slots; only deeper writes can affect shared children.
  if (t.isObjectExpression(node) || t.isArrayExpression(node)) {
    if (effect === "write" && path.length < 2) return [];
    return t.isObjectExpression(node)
      ? objectReferencedValues(node, path)
      : arrayReferencedValues(node, path);
  }
  if (t.isAssignmentExpression(node))
    return node.operator === "||=" || node.operator === "??="
      ? [
          { node: node.left, path },
          { node: node.right, path },
        ]
      : [{ node: node.right, path }];
  if (t.isAwaitExpression(node)) return [{ node: node.argument, path }];
  if (t.isSequenceExpression(node)) {
    const last = node.expressions.at(-1);
    return last === undefined ? [] : [{ node: last, path }];
  }
  if (t.isConditionalExpression(node))
    return [
      { node: node.consequent, path },
      { node: node.alternate, path },
    ];
  if (t.isLogicalExpression(node))
    return [
      { node: node.left, path },
      { node: node.right, path },
    ];
  return [];
};

type MutationObservableOrigin =
  | t.ObjectExpression
  | t.ArrayExpression
  | "ambient"
  | "array"
  | "array-prototype"
  | "opaque";

interface MutationObserverNode {
  origins?: Set<MutationObservableOrigin>;
  sources?: Set<MutationObserverNode>;
  dependents?: Set<MutationObserverNode>;
  projections?: Map<string, MutationObserverNode>;
  readonly read?: {
    readonly source: MutationObserverNode;
    readonly key: PropertyPath[number];
  };
}

const observableMutationPaths = (
  state: JavaScriptSemanticAnalysisState,
): ((
  bindingId: string,
  path: PropertyPath,
  effect: ValueEffect,
) => PropertyPath | null) => {
  const bindingNodes = new Map<string, MutationObserverNode>();
  const expressions = new WeakMap<t.Node, MutationObserverNode>();
  const pendingExpressions: {
    readonly expression: t.Node;
    readonly observer: MutationObserverNode;
  }[] = [];
  const pending: MutationObserverNode[] = [];
  const queued = new Set<MutationObserverNode>();
  const schedule = (node: MutationObserverNode): void => {
    if (queued.has(node)) return;
    queued.add(node);
    pending.push(node);
  };
  const create = (read?: MutationObserverNode["read"]): MutationObserverNode =>
    // Most bindings have no object origin or property projection. Materialize
    // each collection only when it contains a fact or relationship.
    read === undefined ? {} : { read };
  const link = (
    source: MutationObserverNode,
    target: MutationObserverNode,
  ): void => {
    if (target.sources?.has(source) === true) return;
    (target.sources ??= new Set()).add(source);
    (source.dependents ??= new Set()).add(target);
    schedule(target);
  };
  const expressionNode = (node: t.Node): MutationObserverNode => {
    const expression = unwrapJavaScriptExpression(node).node;
    const existing = expressions.get(expression);
    if (existing !== undefined) return existing;
    const observer = create();
    expressions.set(expression, observer);
    pendingExpressions.push({ expression, observer });
    return observer;
  };
  const project = (
    source: MutationObserverNode,
    path: PropertyPath,
  ): MutationObserverNode => {
    let observer = source;
    for (const key of path) {
      const identity = JSON.stringify(
        key === null || typeof key === "object" ? key : String(key),
      );
      let selected = observer.projections?.get(identity);
      if (selected === undefined) {
        selected = create({ source: observer, key });
        (observer.projections ??= new Map()).set(identity, selected);
        (observer.dependents ??= new Set()).add(selected);
        schedule(selected);
      }
      observer = selected;
    }
    return observer;
  };
  for (const binding of state.bindingsById.values())
    bindingNodes.set(binding.bindingId, create());
  for (const binding of state.bindingsById.values()) {
    const observer = bindingNodes.get(binding.bindingId);
    if (observer === undefined) continue;
    for (const initializer of binding.initializers)
      link(
        project(expressionNode(initializer.node), initializer.projection),
        observer,
      );
    // Preserve exact paths where copies, defaults or iteration need their
    // reference-specific projections; an opaque origin prevents pruning.
    if (binding.referenceInitializers.length > 0)
      (observer.origins ??= new Set()).add("opaque");
    for (const initializer of binding.referenceInitializers) {
      for (const source of [
        initializer,
        ...(initializer.requiredSources ?? []),
        ...(initializer.fallbackSources ?? []),
      ])
        link(expressionNode(source.node), observer);
    }
  }
  const settle = (): void => {
    while (pendingExpressions.length > 0 || pending.length > 0) {
      while (pendingExpressions.length > 0) {
        const selected = pendingExpressions.pop();
        if (selected === undefined) break;
        const { expression, observer } = selected;
        if (t.isObjectExpression(expression) || t.isArrayExpression(expression))
          (observer.origins ??= new Set()).add(expression);
        else if (t.isIdentifier(expression)) {
          const binding = resolveSemanticBindingState(
            state,
            expression,
            expression.name,
          );
          if (binding !== undefined) {
            const origin = bindingNodes.get(binding.bindingId);
            if (origin !== undefined) link(origin, observer);
          } else if (expression.name === "Array")
            (observer.origins ??= new Set()).add("array");
          else if (
            ["globalThis", "global", "window", "self"].includes(expression.name)
          )
            (observer.origins ??= new Set()).add("ambient");
        } else if (
          t.isMemberExpression(expression) ||
          t.isOptionalMemberExpression(expression)
        )
          link(
            project(expressionNode(expression.object), [
              semanticStaticPropertyKey(
                expression.property,
                expression.computed,
              ),
            ]),
            observer,
          );
        else
          for (const reference of referencedValues(expression, [], "escape"))
            link(
              project(expressionNode(reference.node), reference.path),
              observer,
            );
        schedule(observer);
      }
      const observer = pending.pop();
      if (observer === undefined) continue;
      queued.delete(observer);
      let changed = false;
      const add = (origin: MutationObservableOrigin): void => {
        if (observer.origins?.has(origin) === true) return;
        (observer.origins ??= new Set()).add(origin);
        changed = true;
      };
      for (const source of observer.sources ?? [])
        for (const origin of source.origins ?? []) add(origin);
      if (observer.read !== undefined) {
        const { source, key } = observer.read;
        if (key === null || typeof key === "object") {
          // Dynamic keys and copied-slot masks retain their original paths.
          // Enumerating their exclusion combinations would recreate the growth
          // that the mutation collector's selection union already prevents.
          if ((source.origins?.size ?? 0) > 0) add("opaque");
        } else
          for (const origin of source.origins ?? []) {
            if (typeof origin === "string") {
              if (origin === "array-prototype" || origin === "opaque")
                add(origin);
              else if (
                origin === "ambient" &&
                semanticPropertyPathKeyMatches(key, "Array")
              )
                add("array");
              else if (
                origin === "array" &&
                semanticPropertyPathKeyMatches(key, "prototype")
              )
                add("array-prototype");
            } else {
              for (const reference of referencedValues(
                origin,
                [key],
                "escape",
              )) {
                link(
                  project(expressionNode(reference.node), reference.path),
                  observer,
                );
                if (reference.iterableFallbackPath !== undefined)
                  link(
                    project(
                      expressionNode(reference.node),
                      reference.iterableFallbackPath,
                    ),
                    observer,
                  );
              }
            }
          }
      }
      if (changed)
        for (const dependent of observer.dependents ?? []) schedule(dependent);
    }
  };
  settle();
  return (bindingId, path, effect) => {
    let observer = bindingNodes.get(bindingId);
    if (observer === undefined) return path;
    if (path.some((key) => key !== null && typeof key === "object"))
      return path;
    if (effect === "escape") {
      observer = project(observer, path);
      settle();
      return (observer.origins?.size ?? 0) === 0 ? null : path;
    }
    if ((observer.origins?.size ?? 0) === 0)
      return path.length === 0 ? path : [null];
    for (let offset = 0; offset < path.length; offset++) {
      const key = path[offset];
      if (key === undefined) break;
      observer = project(observer, [key]);
      settle();
      if ((observer.origins?.size ?? 0) === 0 && offset + 1 < path.length)
        return [...path.slice(0, offset + 1), null];
    }
    return path;
  };
};

const objectReferencedValues = (
  node: t.ObjectExpression,
  path: PropertyPath,
): readonly ReferencedValue[] => {
  const [key, ...remaining] = path;
  const references: ReferencedValue[] = [];
  const overwritten = new Set<string>();
  for (const property of [...node.properties].reverse()) {
    if (t.isSpreadElement(property)) {
      const selected = key ?? null;
      if (typeof selected !== "object" && overwritten.has(String(selected)))
        continue;
      references.push({
        node: property.argument,
        path: [
          typeof selected === "object"
            ? {
                ...selected,
                excludedKeys: [
                  ...new Set([
                    ...(selected?.excludedKeys ?? []),
                    ...overwritten,
                  ]),
                ].sort(compareUnicodeCodePoints),
              }
            : selected,
          ...remaining,
        ],
      });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name !== null && overwritten.has(name)) continue;
    if (name === null || semanticPropertyPathKeyMatches(key ?? null, name))
      references.push({
        node: t.isObjectProperty(property) ? property.value : property,
        path: remaining,
      });
    // A prototype setter does not replace an own property from a spread.
    if (
      name !== null &&
      !(t.isObjectMethod(property) && property.kind !== "method") &&
      !(
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        name === "__proto__"
      )
    )
      overwritten.add(name);
  }
  return references;
};

const arrayReferencedValues = (
  node: t.ArrayExpression,
  path: PropertyPath,
): readonly ReferencedValue[] => {
  const [key, ...remaining] = path;
  const selected = key ?? null;
  const selectedIndex =
    typeof selected === "object" ? null : semanticArrayIndex(selected);
  if (typeof selected !== "object" && selectedIndex === null) return [];
  const references: ReferencedValue[] = [];
  let minimumIndex = 0;
  let uncertainIndex = false;
  for (const element of node.elements) {
    if (t.isSpreadElement(element)) {
      if (selectedIndex === null || selectedIndex >= minimumIndex) {
        let sourceKey: PropertyPath[number] = null;
        if (!uncertainIndex) {
          if (selectedIndex !== null) sourceKey = selectedIndex - minimumIndex;
          else if (selected !== null && typeof selected === "object")
            sourceKey = {
              excludedKeys: selected.excludedKeys.flatMap((name) => {
                const index = semanticArrayIndex(name);
                return index === null || index < minimumIndex
                  ? []
                  : [String(index - minimumIndex)];
              }),
              startIndex: Math.max(
                0,
                (selected.startIndex ?? 0) - minimumIndex,
              ),
            };
        }
        references.push({
          node: element.argument,
          path: [sourceKey, ...remaining],
          iterableFallbackPath: [],
        });
      }
      uncertainIndex = true;
      continue;
    }
    if (
      element !== null &&
      (uncertainIndex
        ? selectedIndex === null || selectedIndex >= minimumIndex
        : semanticPropertyPathKeyMatches(selected, String(minimumIndex)))
    )
      references.push({ node: element, path: remaining });
    minimumIndex++;
  }
  return references;
};

const copiedReferencePath = (
  initializer: JavaScriptSemanticBindingState["referenceInitializers"][number],
  path: PropertyPath,
  effect: ValueEffect,
): PropertyPath | null => {
  const offset = initializer.copyProjectionOffset;
  if (offset === undefined) return [...initializer.projection, ...path];
  const copiedPath = [...initializer.projection.slice(offset + 1), ...path];
  if (effect === "write" && copiedPath.length < 2) return null;
  let [key, ...remaining] = copiedPath;
  if (initializer.copyKind === "array-rest") {
    const startIndex = initializer.copyStartIndex ?? 0;
    if (key === undefined || key === null)
      key = { excludedKeys: [], startIndex };
    else if (typeof key === "object")
      key = {
        excludedKeys: key.excludedKeys.flatMap((name) => {
          const index = semanticArrayIndex(name);
          return index === null ? [] : [String(index + startIndex)];
        }),
        startIndex: (key.startIndex ?? 0) + startIndex,
      };
    else {
      const index = semanticArrayIndex(key);
      if (index === null) return null;
      key = index + startIndex;
    }
  } else {
    const excludedKeys = initializer.copyExcludedKeys ?? [];
    if (key === undefined || key === null) key = { excludedKeys };
    else if (typeof key === "object")
      key = {
        ...key,
        excludedKeys: [...new Set([...key.excludedKeys, ...excludedKeys])].sort(
          compareUnicodeCodePoints,
        ),
      };
    else if (excludedKeys.includes(String(key))) return null;
  }
  return [...initializer.projection.slice(0, offset), key, ...remaining];
};

const selectedReferenceSlot = (
  source: { readonly node: t.Node; readonly projection: PropertyPath },
  state: JavaScriptSemanticAnalysisState,
  capturePoint?: t.Node,
) => {
  const path: string[] = [];
  for (const key of source.projection) {
    if (key === null || typeof key === "object") return undefined;
    path.push(String(key));
  }
  return semanticSlotAtPath(
    evaluateSemanticExpression(source.node, state, capturePoint),
    path,
  );
};
