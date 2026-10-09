import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

/** Deduplicate and sort strings with canonical code-point ordering. */
export const uniqueSorted = <Value extends string>(
  values: readonly Value[],
): Value[] => [...new Set(values)].sort(compareUnicodeCodePoints);
