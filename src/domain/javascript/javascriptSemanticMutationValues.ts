import type { JavaScriptSemanticValue } from "./javascriptSemanticIr.js";

/** Invalidate only slots that an explicit mutation can affect. */
export const invalidateSemanticMutationPath = (
  value: JavaScriptSemanticValue,
  path: readonly (string | number | null)[],
): JavaScriptSemanticValue => {
  const [key, ...remaining] = path;
  const unknown: JavaScriptSemanticValue = {
    status: "unknown",
    reason: "This property may have been mutated.",
  };
  if (key === undefined || key === null) return unknown;
  if (value.status === "object") {
    const name = String(key);
    const observed = value.properties.some(
      (property) => property.name === name,
    );
    const properties = value.properties.map((property) =>
      property.name === name
        ? {
            ...property,
            value: invalidateSemanticMutationPath(property.value, remaining),
          }
        : property,
    );
    return value.unknownProperties || !observed
      ? {
          status: "object",
          properties,
          unknownProperties: true,
          omittedProperties: observed ? value.omittedProperties : null,
        }
      : {
          status: "object",
          properties,
          unknownProperties: false,
          omittedProperties: 0,
        };
  }
  if (value.status === "array") {
    const index = typeof key === "number" ? key : Number(key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      String(index) !== String(key)
    )
      return unknown;
    const observed = value.items[index] !== undefined;
    const items = value.items.map((item, position) =>
      position === index
        ? invalidateSemanticMutationPath(item, remaining)
        : item,
    );
    return value.unknownItems || !observed
      ? {
          status: "array",
          items,
          unknownItems: true,
          omittedItems: observed ? value.omittedItems : null,
        }
      : { status: "array", items, unknownItems: false, omittedItems: 0 };
  }
  return unknown;
};
