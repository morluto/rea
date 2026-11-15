// Counts local limit classes declared on plain Error: a class whose name has
// Limit, Budget, Exhausted or Exceeded and that extends Error directly. Type
// parameters and line breaks between tokens are allowed, as a formatter or a
// generic declaration may write them.
const localLimitClass =
  /\bclass\s+\w*(?:Limit|Budget|Exhausted|Exceeded)\w*\s*(?:<[^{]*?>)?\s*extends\s+Error\b/gu;

/** @param {string} content */
export const localLimitErrorClassCount = (content) =>
  content.match(localLimitClass)?.length ?? 0;
