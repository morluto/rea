import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticReferenceSourcesInactive } from "./javascriptSemanticReferenceSources.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { semanticContainer } from "./javascriptSemanticSlots.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";

// ECMAScript Object.prototype properties, including legacy accessor helpers.
// These can be inherited even with no visible prototype writes in the source.
const OBJECT_PROTOTYPE_KEYS = new Set([
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** Own-slot absence is not a Get proof when a prototype may supply that slot. */
const literalReferenceSource = (
  source: {
    readonly node: t.Node;
    readonly projection: JavaScriptSemanticPropertyPath;
  },
  state: JavaScriptSemanticAnalysisState,
  unknownPrototypes: ReadonlySet<string>,
): boolean => {
  if (!literalDataSource(source.node, state)) return false;
  let value = evaluateSemanticExpression(source.node, state, source.node);
  for (const key of source.projection) {
    if (key === null || typeof key === "object") return false;
    const container = semanticContainer(value);
    if (container === null) return false;
    const name = String(key);
    const slot = container.slots.find((item) => item.name === name);
    if (slot === undefined)
      return (
        container.coverage.status === "complete" &&
        !unknownPrototypes.has("Object") &&
        !OBJECT_PROTOTYPE_KEYS.has(name) &&
        (value.status !== "array" ||
          (!unknownPrototypes.has("Array") &&
            semanticArrayIndex(name) !== null))
      );
    if (slot.presence !== "present") return false;
    value = slot.value;
  }
  return true;
};

/** Loader proof can precede member effects; only inline data has no stale mutable reads. */
const literalDataSource = (
  root: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const pending = [root];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const current = pending[cursor];
    if (current === undefined) continue;
    const node = unwrapJavaScriptExpression(current).node;
    if (readExactJavaScriptLiteral(node).found) continue;
    if (t.isArrayExpression(node)) {
      if (state.ambientWrites.covers(["global", "Array", "prototype", null]))
        return false;
      for (const element of node.elements)
        if (element !== null) pending.push(element);
    } else if (t.isObjectExpression(node)) {
      for (const property of node.properties) {
        if (!t.isObjectProperty(property)) return false;
        const key = semanticStaticPropertyKey(property.key, property.computed);
        if (key === null || (key === "__proto__" && !property.computed))
          return false;
        pending.push(property.value);
      }
    } else return false;
  }
  return true;
};

/**
 * Bootstrap proof can run before member effects are indexed. Only discard a
 * reference when literal reads make the shared own-slot selection a Get proof.
 * The loader owner still controls alias traversal and its resource bound.
 */
export const createBootstrapReferenceSourceFilter = (
  state: JavaScriptSemanticAnalysisState,
): ((
  source: Parameters<typeof semanticReferenceSourcesInactive>[0],
) => boolean) => {
  const prototypeEffects = [
    ...state.ambientWriteEffects,
    ...state.ambientEscapeEffects,
  ];
  const unknownPrototypes = new Set(
    ["Object", "Array"].filter((name) =>
      prototypeEffects.some(({ path }) =>
        path
          .slice(0, 3)
          .every((key, index) =>
            semanticPropertyPathKeyMatches(
              key,
              ["global", name, "prototype"][index] ?? "",
            ),
          ),
      ),
    ),
  );
  return (source) =>
    !(
      [
        ...(source.requiredSources ?? []),
        ...(source.fallbackSources ?? []),
      ].every((selection) =>
        literalReferenceSource(selection, state, unknownPrototypes),
      ) && semanticReferenceSourcesInactive(source, state)
    );
};
