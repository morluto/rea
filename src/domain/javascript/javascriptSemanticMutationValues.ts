import type {
  JavaScriptSemanticProperty,
  JavaScriptSemanticValue,
} from "./javascriptSemanticValueTypes.js";
import {
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";

/** Invalidate escaped object references without rewriting their containing slots. */
export const invalidateSemanticEscapedPath = (
  value: JavaScriptSemanticValue,
  path: JavaScriptSemanticPropertyPath,
): JavaScriptSemanticValue => {
  if (value.status !== "object" && value.status !== "array") return value;
  const [key, ...remaining] = path;
  if (key === undefined)
    return {
      status: "unknown",
      reason: "This object reference may have been mutated by a call.",
    };
  const invalidateChild = (
    property: JavaScriptSemanticProperty,
  ): JavaScriptSemanticProperty =>
    semanticPropertyPathKeyMatches(key, property.name)
      ? {
          ...property,
          value: invalidateSemanticEscapedPath(property.value, remaining),
        }
      : property;
  return value.status === "object"
    ? { ...value, properties: value.properties.map(invalidateChild) }
    : { ...value, items: value.items.map(invalidateChild) };
};

/** Invalidate only slots that an explicit mutation can affect. */
export const invalidateSemanticMutationPath = (
  value: JavaScriptSemanticValue,
  path: JavaScriptSemanticPropertyPath,
): JavaScriptSemanticValue => {
  const [key, ...remaining] = path;
  const unknown: JavaScriptSemanticValue = {
    status: "unknown",
    reason: "This property may have been mutated.",
  };
  if (key === undefined || key === null) return unknown;
  if (value.status === "object" || value.status === "array") {
    if (value.status === "array" && key === "length")
      return {
        status: "array",
        items: [],
        unknownItems: true,
        omittedItems: null,
      };
    const slots = value.status === "object" ? value.properties : value.items;
    const observed = slots.some((property) =>
      semanticPropertyPathKeyMatches(key, property.name),
    );
    const properties = slots.map((property) =>
      semanticPropertyPathKeyMatches(key, property.name)
        ? {
            ...property,
            ...(remaining.length === 0
              ? { presence: "unknown-coverage" as const }
              : {}),
            value: invalidateSemanticMutationPath(property.value, remaining),
          }
        : property,
    );
    if (!observed && typeof key !== "object")
      properties.push({
        name: String(key),
        value: unknown,
        presence: "unknown-coverage",
      });
    return value.status === "object"
      ? { ...value, properties }
      : { ...value, items: properties };
  }
  return unknown;
};
