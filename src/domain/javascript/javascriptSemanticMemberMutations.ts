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
import { semanticMutationInitializers } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticArrayIndex,
  semanticPropertyPathCovers,
  semanticPropertyPathKeyMatches,
  semanticPropertyPathUnion,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

type PropertyPath = JavaScriptSemanticPropertyPath;
type ValueEffect = "write" | "escape";

/** Preserve uncertainty from property writes and references exposed to calls. */
export const collectSemanticMemberMutations = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const parents = state.parentsByNode;
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      if (parent !== null) parents.set(node, parent);
    },
  });
  const recordedEffects = new Set<string>();
  const selections = new Map<string, readonly string[]>();
  const coveringPaths = new Map<string, PropertyPath>();
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
    while (pending.length > 0) {
      const current = pending.pop();
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
        const selectorIndex = current.path.findIndex(
          (key) => key !== null && typeof key === "object",
        );
        let path = current.path;
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
        const site = [
          mutation?.start,
          mutation?.end,
          current.originAt?.start,
          current.originAt?.end,
        ];
        // Union paths at each binding state as well. Each loop assignment can
        // prepend its member, so carrying every ordering is factorial, while
        // one covering path keeps every effect of the paths it covers. Paths
        // through different first members stay apart, so a union never widens
        // which members of the binding are affected. Initializers pass on only
        // writes at least two keys deep, so a write covers only writes of its
        // own length.
        const pathState = JSON.stringify([
          binding.bindingId,
          effect,
          path[0],
          effect === "write" ? path.length : null,
          ...site,
        ]);
        const covering = coveringPaths.get(pathState);
        if (covering !== undefined) {
          if (semanticPropertyPathCovers(covering, path)) continue;
          path = semanticPropertyPathUnion(covering, path);
        }
        coveringPaths.set(pathState, path);
        const identity = JSON.stringify([
          binding.bindingId,
          effect,
          path,
          ...site,
        ]);
        if (recordedEffects.has(identity)) continue;
        const value =
          effect === "write"
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
        if (
          t.isArrayExpression(expression) &&
          ((current.path[0] === "__proto__" &&
            (effect === "escape" || current.path.length > 1)) ||
            (current.path[0] === "constructor" &&
              current.path[1] === "prototype"))
        )
          arrayIterationUnknown = true;
        for (const value of referencedValues(
          expression,
          current.path,
          effect,
        )) {
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
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      for (const source of semanticIterationSources(node, parent))
        deferIterable({
          ...source,
          path: source.projection,
          fallbackPath: source.projection,
          bindings: new Set(),
          effect: "escape",
          originAt: source.mutation,
          iterationOnly: true,
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
    for (const reference of pendingReferences.splice(0)) {
      const { initializer } = reference;
      if (referenceSourcesInactive(initializer, state))
        pendingReferences.push(reference);
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
    for (const reference of [...iterableReferences]) {
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
};

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
    if (
      t.isObjectProperty(property) &&
      (name === null || semanticPropertyPathKeyMatches(key ?? null, name))
    )
      references.push({ node: property.value, path: remaining });
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
