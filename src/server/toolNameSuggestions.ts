/** Nearest advertised tool names for an unknown MCP tool name. */

/** Edit distance between two lowercased names, bounded by their lengths. */
const levenshtein = (left: string, right: string): number => {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array<number>(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    [previous, current] = [current, previous];
  }
  return previous[right.length]!;
};

/**
 * Whether every substantial token of the unknown name closely matches a
 * token of the candidate, so `find_xref` reaches `find_xrefs_to_name` and
 * `xrefs` reaches it too, while a lone short token such as `to` matches
 * nothing on its own.
 */
const tokensClose = (unknown: string, candidate: string): boolean => {
  const unknownTokens = unknown.split("_").filter((token) => token.length >= 3);
  if (unknownTokens.length === 0) return false;
  const candidateTokens = candidate.split("_");
  return unknownTokens.every((token) =>
    candidateTokens.some(
      (candidateToken) =>
        candidateToken === token ||
        levenshtein(token, candidateToken) <= 1 ||
        candidateToken.startsWith(token) ||
        token.startsWith(candidateToken),
    ),
  );
};

/**
 * Up to `limit` advertised names nearest the unknown name, nearest first.
 * A name qualifies on a small edit distance, a shared prefix, or closely
 * matching tokens; anything else yields no suggestion rather than a guess.
 * Exact matches rank first, so a cold (currently disabled) tool is named
 * as itself and the caller can load it through discovery.
 */
export const suggestToolNames = (
  unknown: string,
  candidates: readonly string[],
  limit = 3,
): readonly string[] => {
  const name = unknown.toLowerCase();
  if (name.length === 0 || name.length > 128) return [];
  const scored: { readonly name: string; readonly distance: number }[] = [];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const distance = levenshtein(name, lower);
    if (
      distance <= 2 ||
      lower.startsWith(name) ||
      name.startsWith(lower) ||
      tokensClose(name, lower)
    )
      scored.push({ name: candidate, distance });
  }
  scored.sort(
    (left, right) =>
      left.distance - right.distance ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  return scored.slice(0, limit).map(({ name: suggested }) => suggested);
};

/** A suggestion list rendered as `a`, `a or b`, or `a, b, or c`. */
export const formatSuggestedToolNames = (
  suggestions: readonly string[],
): string =>
  suggestions.length === 1
    ? suggestions[0]!
    : suggestions.length === 2
      ? `${suggestions[0]} or ${suggestions[1]}`
      : `${suggestions.slice(0, -1).join(", ")}, or ${suggestions.at(-1)}`;
