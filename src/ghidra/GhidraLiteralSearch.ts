import type { JsonValue } from "../domain/jsonValue.js";
import {
  literalSubstringPredicate,
  matchProcedureNames,
} from "../domain/analysisSearch.js";

/** ASCII-only candidates are exact; every non-ASCII source value stays eligible.
 * Node owns Unicode folding, so the Java runtime's Unicode version cannot omit
 * a match. Null means no ASCII-only value can match this query.
 */
export const ghidraAsciiLiteralCandidate = (pattern: string): string | null => {
  const equivalents = new Map<string, string | null>();
  let candidate = "";
  for (const character of pattern) {
    if (character.charCodeAt(0) < 128) {
      candidate += character.toLowerCase();
      continue;
    }
    let equivalent = equivalents.get(character);
    if (equivalent === undefined) {
      const matches = literalSubstringPredicate(character, false);
      equivalent = null;
      for (let ascii = 0; ascii < 128; ascii++) {
        const value = String.fromCharCode(ascii);
        if (matches(value)) {
          equivalent = value.toLowerCase();
          break;
        }
      }
      equivalents.set(character, equivalent);
    }
    if (equivalent === null) return null;
    candidate += equivalent;
  }
  return candidate;
};

/**
 * Apply Node's folding to the bridge's candidate rows, including the secondary
 * names a procedure row matched. Leave invalid rows present so the inventory
 * owner retains its output error.
 */
export const filterGhidraLiteralCandidates = (
  value: JsonValue,
  pattern: string,
): JsonValue => {
  if (!Array.isArray(value)) return value;
  const matches = literalSubstringPredicate(pattern, false);
  return value.flatMap((item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.value !== "string"
    )
      return [item];
    const { matched_aliases: aliases, ...row } = item;
    const candidates = Array.isArray(aliases) ? aliases : [];
    if (
      !candidates.every((alias): alias is string => typeof alias === "string")
    )
      return [item];
    const matched = matchProcedureNames(
      { ...row, value: item.value },
      candidates,
      matches,
    );
    return matched === undefined ? [] : [matched];
  });
};
