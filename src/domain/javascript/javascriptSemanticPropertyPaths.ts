/** Slots retained by a shallow copy after exclusions or an array prefix. */
export interface JavaScriptSemanticPropertySelection {
  readonly excludedKeys: readonly string[];
  readonly startIndex?: number;
}

/** Internal mutation path, including selected children of a shallow copy. */
export type JavaScriptSemanticPropertyPath = readonly (
  | string
  | number
  | null
  | JavaScriptSemanticPropertySelection
)[];

/** Read only canonical JavaScript array indices, excluding named properties. */
export const semanticArrayIndex = (key: string | number): number | null => {
  const index = Number(key);
  return Number.isInteger(index) &&
    index >= 0 &&
    index < 4_294_967_295 &&
    String(index) === String(key)
    ? index
    : null;
};

/** Test an exact key, wildcard, or copied-slot selection against an own key. */
export const semanticPropertyPathKeyMatches = (
  key: JavaScriptSemanticPropertyPath[number],
  name: string,
): boolean => {
  if (key === null) return true;
  if (typeof key !== "object") return String(key) === name;
  if (key.excludedKeys.includes(name)) return false;
  if (key.startIndex === undefined) return true;
  const index = semanticArrayIndex(name);
  return index !== null && index >= key.startIndex;
};
