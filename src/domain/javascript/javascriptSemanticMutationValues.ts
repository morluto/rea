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
            ...(remaining.length === 0
              ? { presence: "unknown-coverage" as const }
              : {}),
            value: invalidateSemanticMutationPath(property.value, remaining),
          }
        : property,
    );
    if (!observed)
      properties.push({ name, value: unknown, presence: "unknown-coverage" });
    return { ...value, properties };
  }
  if (value.status === "array") {
    const index = typeof key === "number" ? key : Number(key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      String(index) !== String(key)
    )
      return unknown;
    const items = value.items.map((item, position) =>
      position === index
        ? invalidateSemanticMutationPath(item, remaining)
        : item,
    );
    const itemPresence = {
      ...value.itemPresence,
      ...(remaining.length === 0 || value.items[index] === undefined
        ? { [index]: "unknown-coverage" as const }
        : {}),
    };
    return { ...value, items, itemPresence };
  }
  return unknown;
};
