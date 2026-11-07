import { constants } from "node:buffer";
import { getHeapStatistics } from "node:v8";

/** Allow two Evidence records and their consumer expansions within this heap. */
export const javaScriptEvidenceBudgetBytes = (): number =>
  Math.min(
    constants.MAX_STRING_LENGTH,
    Math.floor(getHeapStatistics().heap_size_limit / 12),
  );
