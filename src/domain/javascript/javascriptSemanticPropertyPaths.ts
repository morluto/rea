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

/**
 * Report whether an effect at `covering` already reaches every slot that an
 * effect at `path` can reach: a prefix whose keys match at least as much.
 */
export const semanticPropertyPathCovers = (
  covering: JavaScriptSemanticPropertyPath,
  path: JavaScriptSemanticPropertyPath,
): boolean =>
  covering.length <= path.length &&
  covering.every((key, index) => keyCovers(key, path[index] ?? null));

/** Return the most specific path whose effect covers both paths. */
export const semanticPropertyPathUnion = (
  left: JavaScriptSemanticPropertyPath,
  right: JavaScriptSemanticPropertyPath,
): JavaScriptSemanticPropertyPath =>
  left
    .slice(0, Math.min(left.length, right.length))
    .map((key, index) => keyUnion(key, right[index] ?? null));

const keyCovers = (
  covering: JavaScriptSemanticPropertyPath[number],
  key: JavaScriptSemanticPropertyPath[number],
): boolean => {
  if (covering === null) return true;
  if (key === null) return false;
  if (typeof key !== "object")
    return typeof covering === "object"
      ? semanticPropertyPathKeyMatches(covering, String(key))
      : String(covering) === String(key);
  return (
    typeof covering === "object" &&
    covering.excludedKeys.every((name) => key.excludedKeys.includes(name)) &&
    (covering.startIndex === undefined ||
      (key.startIndex !== undefined && covering.startIndex <= key.startIndex))
  );
};

const keyUnion = (
  left: JavaScriptSemanticPropertyPath[number],
  right: JavaScriptSemanticPropertyPath[number],
): JavaScriptSemanticPropertyPath[number] => {
  if (keyCovers(left, right)) return left;
  if (keyCovers(right, left)) return right;
  if (left === null || right === null) return null;
  if (typeof left !== "object" || typeof right !== "object") return null;
  const excludedKeys = left.excludedKeys.filter((name) =>
    right.excludedKeys.includes(name),
  );
  return left.startIndex === undefined || right.startIndex === undefined
    ? { excludedKeys }
    : { excludedKeys, startIndex: Math.min(left.startIndex, right.startIndex) };
};
