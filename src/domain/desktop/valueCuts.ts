/** The UTF-16 code units a draft keeps of a value, or of an element a value refers to, before the `…` that cuts it. */
export const DRAFT_VALUE_CHARS = 600;
/** The UTF-16 code units a draft keeps of a string in a file's view before the `…` that cuts it. */
export const DRAFT_VIEW_CHARS = 2000;
/** The characters a check's description keeps of a value's JSON before the `…` that cuts it, as UTF-16 code units in REA and code points in the bundle's verifier. */
export const CHECK_VALUE_CHARS = 200;

/** The first character of a value's JSON. */
const JSON_VALUE_START = /^["[{\-\dtfn]/u;

/** Whether the `…` at `index` of `text` ends one of REA's own cuts: a whole draft value, reference or view string, or a value's JSON a check's description quotes after a space. */
export const endsValueCut = (text: string, index: number): boolean => {
  if (text[index] !== "…") return false;
  if (
    text.length === index + 1 &&
    (index === DRAFT_VALUE_CHARS || index === DRAFT_VIEW_CHARS)
  )
    return true;
  const start = index - CHECK_VALUE_CHARS;
  return (
    start >= 0 &&
    (start === 0 || text[start - 1] === " ") &&
    JSON_VALUE_START.test(text.slice(start, start + 1))
  );
};
