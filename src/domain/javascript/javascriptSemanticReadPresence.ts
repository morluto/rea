import * as t from "@babel/types";
import {
  staticObjectPropertyReader,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  bindingPathOnlyEscapesAtLaterIteratorEffects,
  capturedBindingPathMayHaveChanged,
  hasRecordedReferenceEffects,
  opaqueCodeMayRebindBinding,
} from "./javascriptSemanticEffectLog.js";
import { semanticBindingPrecedesCapture } from "./javascriptSemanticMutationInitializers.js";
import { semanticArrayIndex } from "./javascriptSemanticPropertyPaths.js";
import { semanticKnownArrayIteration } from "./javascriptSemanticReferenceSources.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";

interface ReadPresenceOrigin {
  readonly binding: JavaScriptSemanticBindingState;
  readonly value: t.Node;
}

/** Prove a direct data slot in its source at the time of the read. */
export const createSemanticReadPresenceQuery = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const readers = new WeakMap<
    t.ObjectExpression,
    ReturnType<typeof staticObjectPropertyReader>
  >();
  const constAliasOrigins = new WeakMap<
    JavaScriptSemanticBindingState,
    ReadPresenceOrigin | null
  >();
  const constAliasOrigin = (
    initial: JavaScriptSemanticBindingState,
  ): ReadPresenceOrigin | undefined => {
    const pending: JavaScriptSemanticBindingState[] = [];
    let binding = initial;
    let origin = constAliasOrigins.get(binding);
    while (origin === undefined) {
      pending.push(binding);
      const initializer = semanticStableInitializer(binding, state);
      if (
        binding.mutable ||
        !binding.declarationKinds.has("const") ||
        initializer === undefined ||
        initializer.projection.length !== 0 ||
        binding.referenceInitializers.length !== 0
      ) {
        origin = null;
        break;
      }
      const value = unwrapJavaScriptExpression(initializer.node).node;
      if (!t.isIdentifier(value)) {
        origin = { binding, value };
        break;
      }
      const target = resolveSemanticBindingState(state, value, value.name);
      // Each accepted alias captures an already initialized const in this
      // activation, so the walk strictly precedes the last initializer read.
      if (
        target === undefined ||
        !semanticBindingPrecedesCapture(
          target,
          initializer.node,
          state.parentsByNode,
        ) ||
        opaqueCodeMayRebindBinding(target, state, initializer.node)
      ) {
        origin = null;
        break;
      }
      binding = target;
      origin = constAliasOrigins.get(binding);
    }
    for (const visited of pending) constAliasOrigins.set(visited, origin);
    return origin ?? undefined;
  };

  const ownDataAtPath = (value: t.Node, path: readonly string[], from = 0) => {
    let receiver = value;
    for (let index = from; index < path.length; index += 1) {
      const key = path[index]!;
      if (!t.isObjectExpression(receiver)) return undefined;
      let read = readers.get(receiver);
      if (read === undefined) {
        read = staticObjectPropertyReader(receiver);
        readers.set(receiver, read);
      }
      const property = read(key);
      if (property.status !== "explicit") return undefined;
      receiver = unwrapJavaScriptExpression(property.value).node;
    }
    return receiver;
  };

  return (
    bindingId: string | null,
    capture: t.Node,
    iterationPath?: readonly string[],
  ) => {
    const binding =
      bindingId === null ? undefined : state.bindingsById.get(bindingId);
    const initializer = binding?.initializers[0];
    if (
      !state.memberMutationFactsComplete ||
      binding === undefined ||
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      binding.referenceInitializers.length !== 0 ||
      state.conditionallySkippedExpressions.has(initializer.node) ||
      !semanticBindingPrecedesCapture(binding, capture, state.parentsByNode) ||
      opaqueCodeMayRebindBinding(binding, state, capture)
    )
      return undefined;
    const initialValue = unwrapJavaScriptExpression(initializer.node).node;
    const origin = t.isIdentifier(initialValue)
      ? constAliasOrigin(binding)
      : { binding, value: initialValue };
    if (
      origin === undefined ||
      !hasRecordedReferenceEffects(origin.binding, state) ||
      (origin.binding !== binding &&
        !semanticBindingPrecedesCapture(
          origin.binding,
          capture,
          state.parentsByNode,
        ))
    )
      return undefined;
    const { value } = origin;
    // An identifier RHS in an object pattern can select numeric own data
    // without starting an iterator, even when a later read closes one.
    const arrayPath =
      iterationPath ??
      (t.isArrayExpression(value) &&
      t.isIdentifier(unwrapJavaScriptExpression(capture).node)
        ? []
        : undefined);
    if (arrayPath !== undefined) {
      // The RHS must select an own data value before numeric array slots can
      // explain the binding. Temporal checks still use the full origin path.
      const literal = ownDataAtPath(value, arrayPath);
      if (!t.isArrayExpression(literal)) return undefined;
      const array = evaluateSemanticExpression(
        capture,
        state,
        capture,
        "query",
      );
      if (
        array.status !== "array" ||
        array.unknownItems ||
        (iterationPath !== undefined &&
          !semanticKnownArrayIteration(array, state, capture))
      )
        return undefined;
      return (
        path: readonly string[],
        beforeIterator?: t.Node,
      ): t.Node | undefined => {
        if (beforeIterator !== undefined) return undefined;
        const key = path[arrayPath.length];
        if (key === undefined) return undefined;
        const index = semanticArrayIndex(key);
        if (index === null) return undefined;
        const slot = array.items[index];
        const element = literal.elements[index];
        if (
          slot?.name !== key ||
          slot.presence !== "present" ||
          element == null
        )
          return undefined;
        const selected = ownDataAtPath(
          unwrapJavaScriptExpression(element).node,
          path,
          arrayPath.length + 1,
        );
        return selected === undefined ||
          capturedBindingPathMayHaveChanged(
            origin.binding,
            path,
            capture,
            state,
          )
          ? undefined
          : selected;
      };
    }
    if (!t.isObjectExpression(value)) return undefined;
    return (
      path: readonly string[],
      beforeIterator?: t.Node,
    ): t.Node | undefined => {
      if (path.length === 0) return undefined;
      const selected = ownDataAtPath(value, path);
      if (selected === undefined) return undefined;
      const stillPresent =
        beforeIterator === undefined
          ? !capturedBindingPathMayHaveChanged(
              origin.binding,
              path,
              capture,
              state,
            )
          : bindingPathOnlyEscapesAtLaterIteratorEffects(
              origin.binding,
              path,
              beforeIterator,
              state,
            );
      return stillPresent ? selected : undefined;
    };
  };
};
