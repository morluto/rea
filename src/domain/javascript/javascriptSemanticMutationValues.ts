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
    const name = String(key);
    // Array length writes can remove every index; ordinary named properties
    // and sparse indices affect only their own slot.
    if (name === "length") return unknown;
    const observed = value.items.some((item) => item.name === name);
    const items = value.items.map((item) =>
      item.name === name
        ? {
            ...item,
            presence:
              remaining.length === 0
                ? ("unknown-coverage" as const)
                : item.presence,
            value: invalidateSemanticMutationPath(item.value, remaining),
          }
        : item,
    );
    if (!observed)
      items.push({ name, presence: "unknown-coverage", value: unknown });
    return { ...value, items };
  }
  return unknown;
};
