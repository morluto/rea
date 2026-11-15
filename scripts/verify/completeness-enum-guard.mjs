// Counts local zod enums that spell a completeness vocabulary: their literal
// list contains "complete". A detail level (`"complete" | "summary"`) chooses
// how much to return, not what was examined, so a list with "summary" is not
// counted. Whitespace, including line breaks, may separate `z`, `.enum(` and
// `[`, so a formatter's chained layout (`z\n  .enum([...])`) is counted like
// the inline one.
const zodEnumLiterals = /\bz\s*\.\s*enum\s*\(\s*\[([^\]]*)\]/gu;

/** @param {string} content */
export const localCompletenessEnumCount = (content) => {
  let count = 0;
  for (const [, literals] of content.matchAll(zodEnumLiterals))
    if (literals.includes('"complete"') && !literals.includes('"summary"'))
      count += 1;
  return count;
};
