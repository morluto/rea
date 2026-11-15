// Counts local limit classes: a class whose name has Limit, Budget, Exhausted
// or Exceeded and that extends plain Error, or that extends
// BinaryResourceFailure, which already names its allowance in its LimitRef
// (a subclass would keep a second, parallel limit field). Type parameters and
// line breaks between tokens are allowed, as a formatter or a generic
// declaration may write them.
const localLimitClass =
  /\bclass\s+\w*(?:Limit|Budget|Exhausted|Exceeded)\w*\s*(?:<[^{]*?>)?\s*extends\s+(?:Error|BinaryResourceFailure)\b/gu;

/** @param {string} content */
export const localLimitErrorClassCount = (content) =>
  content.match(localLimitClass)?.length ?? 0;
