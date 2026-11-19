import * as t from "@babel/types";
import {
  staticObjectPropertyReader,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
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

  return (
    bindingId: string | null,
    capture: t.Node,
    source: "property" | "array-iteration" = "property",
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
    if (source === "array-iteration") {
      if (!t.isArrayExpression(value)) return undefined;
      const array = evaluateSemanticExpression(
        capture,
        state,
        capture,
        "query",
      );
      if (
        !semanticKnownArrayIteration(array, state, capture) ||
        array.unknownItems
      )
        return undefined;
      return (path: readonly string[]): boolean => {
        const [key] = path;
        if (key === undefined || path.length !== 1) return false;
        const index = semanticArrayIndex(key);
        const slot = index === null ? undefined : array.items[index];
        return (
          slot?.name === key &&
          slot.presence === "present" &&
          !capturedBindingPathMayHaveChanged(
            origin.binding,
            path,
            capture,
            state,
          )
        );
      };
    }
    if (!t.isObjectExpression(value)) return undefined;
    return (path: readonly string[]): boolean => {
      if (path.length === 0) return false;
      let receiver: t.Node = value;
      for (const key of path) {
        if (!t.isObjectExpression(receiver)) return false;
        let read = readers.get(receiver);
        if (read === undefined) {
          read = staticObjectPropertyReader(receiver);
          readers.set(receiver, read);
        }
        const property = read(key);
        if (property.status !== "explicit") return false;
        receiver = unwrapJavaScriptExpression(property.value).node;
      }
      return !capturedBindingPathMayHaveChanged(
        origin.binding,
        path,
        capture,
        state,
      );
    };
  };
};
