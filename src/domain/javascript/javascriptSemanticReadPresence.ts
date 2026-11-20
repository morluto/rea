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
import { semanticArrayLiteralSlots } from "./javascriptSemanticArrayLayout.js";
import { semanticSlotAtPath } from "./javascriptSemanticSlots.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";
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

type ReadOwnData = (
  path: readonly string[],
  beforeIterator?: t.Node,
) => t.Node | undefined;

interface ReadPresence {
  readonly read: ReadOwnData;
  readonly readNestedArray: (
    literal: t.ArrayExpression,
    path: readonly string[],
    fromRhs: readonly string[],
    acquisition: t.ArrayPattern,
  ) => ReadOwnData | undefined;
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
  ): ReadPresence | undefined => {
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
    let rhsSnapshot: JavaScriptSemanticValue | undefined;
    const arraySlots = (
      literal: t.ArrayExpression,
      arrayPath: readonly string[],
      fromRhs: readonly string[],
      acquisition: t.Node | undefined,
    ): ReadOwnData | undefined => {
      rhsSnapshot ??= evaluateSemanticExpression(
        capture,
        state,
        capture,
        "query",
      );
      const selectedArray = semanticSlotAtPath(rhsSnapshot, fromRhs);
      const array = selectedArray.value;
      if (
        selectedArray.presence !== "present" ||
        array.status !== "array" ||
        array.unknownItems ||
        (acquisition !== undefined &&
          !semanticKnownArrayIteration(array, state, acquisition))
      )
        return undefined;
      const elements = semanticArrayLiteralSlots(literal, state);
      if (elements === undefined) return undefined;
      return (path, beforeIterator) => {
        if (
          beforeIterator !== undefined ||
          (fromRhs.length > 0 && path.length !== arrayPath.length + 1)
        )
          return undefined;
        const key = path[arrayPath.length];
        if (key === undefined) return undefined;
        const index = semanticArrayIndex(key);
        if (index === null) return undefined;
        const slot = array.items[index];
        const element = elements[index];
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
    };
    // An identifier RHS in an object pattern can select numeric own data
    // without starting an iterator, even when a later read closes one.
    const arrayPath =
      iterationPath ??
      (t.isArrayExpression(value) &&
      t.isIdentifier(unwrapJavaScriptExpression(capture).node)
        ? []
        : undefined);
    if (arrayPath !== undefined) {
      const literal = ownDataAtPath(value, arrayPath);
      if (!t.isArrayExpression(literal)) return undefined;
      const read = arraySlots(
        literal,
        arrayPath,
        [],
        iterationPath === undefined ? undefined : capture,
      );
      return read === undefined
        ? undefined
        : { read, readNestedArray: arraySlots };
    }
    if (!t.isObjectExpression(value)) return undefined;
    const read: ReadOwnData = (path, beforeIterator) => {
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
    return { read, readNestedArray: arraySlots };
  };
};
