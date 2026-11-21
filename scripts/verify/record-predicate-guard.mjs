/** Count declarations named isRecord and declarations with the shared predicate. */
export const recordPredicateCounts = (content) => {
  const arrow =
    /\bconst\s+[\w$]+\s*=\s*\(\s*([\w$]+)[^)]*\)\s*(?::[^=]+)?=>\s*typeof\s+\1\s*===\s*["']object["']\s*&&\s*\1\s*!==\s*null\s*&&\s*!Array\.isArray\(\1\)\s*(?=;|\})/gu;
  const declaration =
    /\bfunction\s+[\w$]+\s*\(\s*([\w$]+)[^)]*\)\s*(?::[^{]+)?\{\s*return\s+typeof\s+\1\s*===\s*["']object["']\s*&&\s*\1\s*!==\s*null\s*&&\s*!Array\.isArray\(\1\)\s*(?=;|\})/gu;
  return {
    named: [...content.matchAll(/\b(?:const|function)\s+isRecord\b/gu)].length,
    bodies:
      [...content.matchAll(arrow)].length +
      [...content.matchAll(declaration)].length,
  };
};
