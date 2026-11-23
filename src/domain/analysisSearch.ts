import { z } from "zod";

import { nativeSearchInput } from "./native/nativeSearch.js";
import { AnalysisInputError } from "./analysisErrorCore.js";

/** Parsed `search_procedures`/`search_strings` query shared by providers that match in REA. */
export const analysisSearchQuerySchema = z.object(nativeSearchInput);

export type AnalysisSearchQuery = z.infer<typeof analysisSearchQuerySchema>;

/**
 * Match a literal substring. With case ignored, ECMAScript Unicode RegExp
 * matching applies simple case folding character-by-character
 * ([Canonicalize](https://tc39.es/ecma262/2023/multipage/text-processing.html#sec-runtime-semantics-canonicalize));
 * it is locale-independent and does not expand characters into sequences.
 */
export const literalSubstringPredicate = (
  pattern: string,
  caseSensitive: boolean,
): ((value: string) => boolean) => {
  if (pattern.length === 0) return () => true;
  if (caseSensitive) return (value) => value.includes(pattern);
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const regex = new RegExp(escaped, "iu");
  return (value) => regex.test(value);
};

/**
 * Match names the way the search contract describes: a literal substring by
 * default, or a Unicode regular expression, case-insensitive unless requested.
 * An invalid pattern is the caller's input error.
 */
export const analysisSearchPredicate = (
  query: AnalysisSearchQuery,
): ((value: string) => boolean) => {
  if (query.mode === "regex") {
    if (query.pattern.length === 0) return () => true;
    let regex: RegExp;
    try {
      regex = new RegExp(query.pattern, query.case_sensitive ? "u" : "iu");
    } catch (cause: unknown) {
      throw new AnalysisInputError("search", { cause });
    }
    return (value) => regex.test(value);
  }
  return literalSubstringPredicate(query.pattern, query.case_sensitive);
};

/**
 * Distinct matching secondary names in provider order, or undefined when none
 * match. Avoids Set and array allocations on the common miss path.
 */
export const matchedProcedureAliases = (
  primaryName: string,
  aliases: readonly string[],
  matches: (value: string) => boolean,
): string[] | undefined => {
  if (aliases.length === 0) return undefined;
  if (aliases.length === 1) {
    const alias = aliases[0]!;
    return alias !== primaryName && matches(alias) ? [alias] : undefined;
  }
  let matched: string[] | undefined;
  if (aliases.length <= 8) {
    for (let i = 0; i < aliases.length; i += 1) {
      const alias = aliases[i]!;
      if (alias === primaryName) continue;
      let duplicate = false;
      for (let j = 0; j < i; j += 1) {
        if (aliases[j] === alias) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate && matches(alias)) {
        if (matched === undefined) matched = [alias];
        else matched.push(alias);
      }
    }
    return matched;
  }
  const seen = new Set<string>([primaryName]);
  for (let i = 0; i < aliases.length; i += 1) {
    const alias = aliases[i]!;
    if (!seen.has(alias)) {
      seen.add(alias);
      if (matches(alias)) {
        if (matched === undefined) matched = [alias];
        else matched.push(alias);
      }
    }
  }
  return matched;
};

/**
 * Match one procedure by its primary name and the secondary names its provider
 * accepts for exact selection. A procedure remains one row whose value is its
 * primary name; matched_aliases keeps each distinct matching secondary
 * spelling in provider order, so an alias never becomes a procedure of its own.
 */
export const matchProcedureNames = <Row extends { readonly value: string }>(
  row: Row,
  aliases: readonly string[],
  matches: (value: string) => boolean,
): (Row & { readonly matched_aliases?: string[] }) | undefined => {
  const matched = matchedProcedureAliases(row.value, aliases, matches);
  if (matched !== undefined) return { ...row, matched_aliases: matched };
  return matches(row.value) ? row : undefined;
};
