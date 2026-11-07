import type * as t from "@babel/types";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath as PropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { semanticSlotAtPath } from "./javascriptSemanticSlots.js";

interface ReferenceSource {
  readonly node: t.Node;
  readonly projection: PropertyPath;
}

/** Exclude references whose source slot or destructuring fallback is absent. */
export const semanticReferenceSourcesInactive = (
  reference: {
    readonly requiredSources?: readonly ReferenceSource[];
    readonly fallbackSources?: readonly ReferenceSource[];
  },
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  reference.requiredSources?.some(
    (source) =>
      semanticSelectedReferenceSlot(source, state, source.node)?.presence ===
      "absent",
  ) === true ||
  reference.fallbackSources?.some((source) => {
    // Selection precedes effects through the chosen reference. A later escape
    // cannot make a fallback that was excluded at destructuring reachable.
    const slot = semanticSelectedReferenceSlot(source, state, source.node);
    return (
      slot?.presence === "present" &&
      (slot.value.status === "literal" ||
        slot.value.status === "union" ||
        slot.value.status === "object" ||
        slot.value.status === "array")
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
  return semanticSlotAtPath(
    evaluateSemanticExpression(source.node, state, capturePoint),
    path,
  );
};

export const copiedReferencePath = (
  initializer: JavaScriptSemanticBindingState["referenceInitializers"][number],
  path: PropertyPath,
  effect: "write" | "escape",
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
