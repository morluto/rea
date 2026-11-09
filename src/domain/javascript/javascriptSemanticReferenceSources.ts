import type * as t from "@babel/types";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";
import { javaScriptTaggedTemplateRawStrings } from "./javascriptIntrinsicInvocation.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath as PropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  evaluateSemanticExpression,
  semanticValueDefinitelyDefined,
} from "./javascriptSemanticValues.js";
import { semanticSlotAtPath } from "./javascriptSemanticSlots.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";

/**
 * Node's wrapper module inherits require. A copy cannot read that delegate
 * unless an earlier own-slot write or opaque module escape may have exposed it.
 */
export const semanticCommonJsRequireOwnEnumerableAt = (
  capture: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const selected = ["commonjs-module", "require"];
  const mayAffect = (
    effect: JavaScriptSemanticAnalysisState["ambientWriteEffects"][number],
  ) =>
    effect.path.length <= selected.length &&
    effect.path.every((key, index) =>
      semanticPropertyPathKeyMatches(key, selected[index] ?? ""),
    ) &&
    semanticEffectTiming(capture, effect.node, state) !== "after";
  return (
    state.ambientWriteEffects.some(mayAffect) ||
    state.ambientEscapeEffects.some(mayAffect)
  );
};

interface ReferenceSource {
  readonly node: t.Node;
  readonly projection: PropertyPath;
  readonly iterationSources?: readonly ReferenceSource[];
}

/** Native array iteration preserves numeric slots only while its iterator is intact. */
export const semanticKnownArrayIteration = (
  value: JavaScriptSemanticValue | undefined,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  !state.arrayIterationUnknown &&
  value?.status === "array" &&
  value.items.every((item) => semanticArrayIndex(item.name) !== null);

/** Invocation spreads use the same native-iteration proof at their source read. */
export const semanticKnownArrayIterationAt = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  capturePoint: t.Node = node,
): boolean =>
  semanticKnownArrayIteration(
    evaluateSemanticExpression(node, state, capturePoint),
    state,
  );

/** Numeric destructuring projections do not select slots of custom iterators. */
export const semanticReferenceIterationUnknown = (
  source: { readonly iterationSources?: readonly ReferenceSource[] },
  state: JavaScriptSemanticAnalysisState,
  capturePoint?: t.Node,
): boolean =>
  source.iterationSources?.some(
    (iterable) =>
      !selectedReferenceIterationKnown(
        iterable,
        state,
        capturePoint ?? iterable.node,
      ),
  ) === true;

const selectedReferenceIterationKnown = (
  source: ReferenceSource,
  state: JavaScriptSemanticAnalysisState,
  capturePoint: t.Node = source.node,
): boolean => {
  const rawStrings =
    source.projection[0] === "raw"
      ? javaScriptTaggedTemplateRawStrings(
          unwrapJavaScriptExpression(source.node).node,
        )
      : undefined;
  let values = [
    evaluateSemanticExpression(rawStrings ?? source.node, state, capturePoint),
  ];
  const remainingProjection =
    rawStrings === undefined ? source.projection : source.projection.slice(1);
  for (const key of remainingProjection) {
    if (typeof key === "object" && key !== null) return false;
    const selected = new Set<JavaScriptSemanticValue>();
    for (const value of values) {
      if (key === null) {
        // for-of projects any position of a native array. Its finite slot
        // inventory can prove every possible nested iterable without treating
        // a computed object property or custom iterator as an own-index read.
        if (
          !semanticKnownArrayIteration(value, state) ||
          value.status !== "array" ||
          value.unknownItems
        )
          return false;
        for (const slot of value.items) {
          if (slot.presence !== "present") return false;
          selected.add(slot.value);
        }
      } else {
        const slot = semanticSlotAtPath(value, [String(key)]);
        if (slot.presence !== "present") return false;
        selected.add(slot.value);
      }
    }
    values = [...selected];
  }
  return values.every((value) => semanticKnownArrayIteration(value, state));
};

/** Exclude references whose source slot or destructuring fallback is absent. */
export const semanticReferenceSourcesInactive = (
  reference: {
    readonly iterationSources?: readonly ReferenceSource[];
    readonly requiredSources?: readonly ReferenceSource[];
    readonly fallbackSources?: readonly ReferenceSource[];
  },
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  reference.requiredSources?.some(
    (source) =>
      !semanticReferenceIterationUnknown(source, state) &&
      semanticSelectedReferenceSlot(source, state, source.node)?.presence ===
        "absent",
  ) === true ||
  reference.fallbackSources?.some((source) => {
    // Selection precedes effects through the chosen reference. A later escape
    // cannot make a fallback that was excluded at destructuring reachable.
    const slot = semanticSelectedReferenceSlot(source, state, source.node);
    return (
      !semanticReferenceIterationUnknown(source, state) &&
      slot?.presence === "present" &&
      semanticValueDefinitelyDefined(slot.value)
    );
  }) === true;

/** Select a retained source slot at its capture, before later effects. */
export const semanticSelectedReferenceSlot = (
  source: ReferenceSource,
  state: JavaScriptSemanticAnalysisState,
  capturePoint?: t.Node,
) => {
  const path: string[] = [];
  for (const key of source.projection) {
    if (key === null || typeof key === "object") return undefined;
    path.push(String(key));
  }
  const rawStrings =
    path[0] === "raw"
      ? javaScriptTaggedTemplateRawStrings(
          unwrapJavaScriptExpression(source.node).node,
        )
      : undefined;
  if (rawStrings !== undefined) {
    return semanticSlotAtPath(
      evaluateSemanticExpression(rawStrings, state, capturePoint),
      path.slice(1),
    );
  }
  return semanticSlotAtPath(
    evaluateSemanticExpression(source.node, state, capturePoint),
    path,
  );
};
