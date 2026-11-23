import type { JsonValue } from "../domain/jsonValue.js";
import {
  literalSubstringPredicate,
  matchProcedureNames,
} from "../domain/analysisSearch.js";

/** Explain the retained bridge observation when Node owns final matching. */
export const GHIDRA_LITERAL_CANDIDATES_LIMITATION =
  "For this case-insensitive literal search, raw_result contains Ghidra's candidate rows before REA's Unicode-aware filtering; normalized_result contains the matches.";

const asciiFoldEquivalent = (
  character: string,
  equivalents: Map<string, string | null>,
): string | null => {
  if (character.charCodeAt(0) < 128) return character.toLowerCase();
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
  return equivalent;
};

/** ASCII-only candidates are exact; every non-ASCII source value stays eligible.
 * Node owns Unicode folding, so the Java runtime's Unicode version cannot omit
 * a match. Null means no ASCII-only value can match this query.
 */
export const ghidraAsciiLiteralCandidate = (pattern: string): string | null => {
  const equivalents = new Map<string, string | null>();
  let candidate = "";
  for (const character of pattern) {
    const equivalent = asciiFoldEquivalent(character, equivalents);
    if (equivalent === null) return null;
    candidate += equivalent;
  }
  return candidate;
};

/**
 * Longest ASCII-foldable substring inside a non-ASCII case-insensitive literal
 * query. Every matching source string must contain both a non-ASCII character
 * and this folded ASCII run, preventing bridge IPC floods on localized binaries.
 */
export const ghidraAsciiLiteralSubstring = (pattern: string): string | null => {
  const equivalents = new Map<string, string | null>();
  let best = "";
  let current = "";
  for (const character of pattern) {
    const equivalent = asciiFoldEquivalent(character, equivalents);
    if (equivalent === null) {
      if (current.length > best.length) best = current;
      current = "";
    } else {
      current += equivalent;
    }
  }
  if (current.length > best.length) best = current;
  return best.length > 0 ? best : null;
};

/**
 * Apply Node's folding to the bridge's candidate rows, including the secondary
 * names a procedure row matched. The bridge matches leaf and qualified
 * spellings but reports qualified ones; a leaf ends its qualified spelling, so
 * a literal is found in one only if it is found in the other. Leave invalid
 * rows present so the inventory owner retains its output error.
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
