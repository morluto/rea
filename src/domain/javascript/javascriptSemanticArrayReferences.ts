import * as t from "@babel/types";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";

type PropertyPath = JavaScriptSemanticPropertyPath;
export interface ArrayReference {
  readonly node: t.Node;
  readonly path: PropertyPath;
  readonly iterableFallbackPath?: PropertyPath;
}

export const arrayReferencedValues = (
  node: t.ArrayExpression,
  path: PropertyPath,
): readonly ArrayReference[] => {
  const [key, ...remaining] = path;
  const selected = key ?? null;
  const selectedIndex =
    typeof selected === "object" ? null : semanticArrayIndex(selected);
  if (typeof selected !== "object" && selectedIndex === null) return [];
  const references: ArrayReference[] = [];
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
