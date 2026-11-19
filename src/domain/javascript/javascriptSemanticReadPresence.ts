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
import { semanticNativeArrayIterationValueAt } from "./javascriptSemanticReferenceSources.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

/** Prove a direct data slot in its source at the time of the read. */
export const createSemanticReadPresenceQuery = (
  state: JavaScriptSemanticAnalysisState,
) => {
  const readers = new WeakMap<
    t.ObjectExpression,
    ReturnType<typeof staticObjectPropertyReader>
  >();
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
      !hasRecordedReferenceEffects(binding, state) ||
      state.conditionallySkippedExpressions.has(initializer.node) ||
      !semanticBindingPrecedesCapture(binding, capture, state.parentsByNode) ||
      opaqueCodeMayRebindBinding(binding, state, capture)
    )
      return undefined;
    const value = unwrapJavaScriptExpression(initializer.node).node;
    if (source === "array-iteration") {
      if (!t.isArrayExpression(value)) return undefined;
      const array = semanticNativeArrayIterationValueAt(capture, state);
      if (array === undefined || array.unknownItems) return undefined;
      return (path: readonly string[]): boolean => {
        const [key] = path;
        if (key === undefined || path.length !== 1) return false;
        const index = semanticArrayIndex(key);
        const slot = index === null ? undefined : array.items[index];
        return (
          slot?.name === key &&
          slot.presence === "present" &&
          !capturedBindingPathMayHaveChanged(binding, path, capture, state)
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
      return !capturedBindingPathMayHaveChanged(binding, path, capture, state);
    };
  };
};
