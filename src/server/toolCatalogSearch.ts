/** One currently advertised MCP tool that discovery or unknown-tool hints may examine. */
export interface AdvertisedToolDescriptor {
  readonly name: string;
  readonly description?: string | undefined;
}

/** Live advertisement snapshot consulted when a tools/call names an unknown tool. */
export interface AdvertisedToolCatalog {
  readonly tools: readonly AdvertisedToolDescriptor[];
  readonly discoveryAvailable: boolean;
  /** In-scope tools discover_tools can load but this connection has not loaded. */
  readonly unloadedTools?: ReadonlySet<string>;
}

/** Pre-normalized tool search text shared by discover_tools and unknown-tool hints. */
export interface SearchableCatalogTool {
  readonly name: string;
  readonly search: string;
  readonly descriptionLead: string;
}

/** Fixed ceiling above the longest advertised tool name to bound unknown-tool tokenization work. */
const MAX_UNKNOWN_TOOL_NAME_LENGTH = 128;
/** Fixed display cap so -32602 remediation stays compact without re-sending the tool catalog. */
const DEFAULT_MAX_SUGGESTIONS = 5;

/** Build the normalized search text shared by discover_tools and unknown-tool remediation. */
export const createSearchableCatalogTool = (
  name: string,
  description: string | undefined,
): SearchableCatalogTool => {
  const descriptionLead = (description ?? "").trimStart().toLowerCase();
  return {
    name,
    search:
      `${name} ${name.replaceAll("_", " ")} ${descriptionLead}`.toLowerCase(),
    descriptionLead,
  };
};

/**
 * Rank catalog tools against normalized lowercase query words.
 * - `mode: "all"` requires every word to match (empty words list every tool in alphabetical order,
 *   matching discover_tools browsing semantics).
 * - `mode: "any"` matches tools containing at least one word (callers pass distinct words),
 *   ranking by matched word count first.
 * Within equal match counts, name matches outrank description-only matches. When
 * `preferDescriptionLead` is true (used for compact unknown-tool suggestions, leaving
 * `discover_tools` ordering unchanged), description-only matches whose description starts with a
 * query word outrank mid-sentence mentions before breaking ties alphabetically by tool name.
 */
export const rankCatalogToolMatches = (
  tools: Iterable<SearchableCatalogTool>,
  words: readonly string[],
  mode: "all" | "any",
  preferDescriptionLead = false,
): readonly string[] => {
  const ranked: {
    readonly name: string;
    readonly matchedWords: number;
    readonly nameScore: number;
    readonly leadMatch: number;
  }[] = [];
  for (const tool of tools) {
    let matchedWords = 0;
    for (let i = 0; i < words.length; i += 1) {
      if (tool.search.includes(words[i]!)) matchedWords += 1;
    }
    if (mode === "all") {
      if (matchedWords !== words.length) continue;
    } else if (matchedWords === 0) {
      continue;
    }
    let nameScore = 0;
    for (let i = 0; i < words.length; i += 1) {
      if (tool.name.includes(words[i]!)) nameScore += 1;
    }
    const leadMatch =
      preferDescriptionLead &&
      nameScore === 0 &&
      words.some((word) => tool.descriptionLead.startsWith(word))
        ? 1
        : 0;
    ranked.push({ name: tool.name, matchedWords, nameScore, leadMatch });
  }
  ranked.sort(
    (left, right) =>
      right.matchedWords - left.matchedWords ||
      right.nameScore - left.nameScore ||
      right.leadMatch - left.leadMatch ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  return ranked.map((entry) => entry.name);
};

/**
 * Suggest up to `limit` currently advertised MCP tools for an unknown requested
 * name by splitting on `_`, `-`, and whitespace and running the shared catalog
 * search: all-word matches first, falling back to any-word matches when none
 * match every word.
 */
export const suggestAdvertisedTools = (
  requested: string,
  candidates: readonly AdvertisedToolDescriptor[],
  limit = DEFAULT_MAX_SUGGESTIONS,
): readonly string[] => {
  if (limit <= 0) return [];
  const trimmed = requested.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_UNKNOWN_TOOL_NAME_LENGTH)
    return [];
  const words = [
    ...new Set(
      trimmed
        .toLowerCase()
        .split(/[\s_-]+/u)
        .filter(Boolean),
    ),
  ];
  if (words.length === 0) return [];

  const seen = new Set<string>();
  const searchable: SearchableCatalogTool[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.name)) continue;
    seen.add(candidate.name);
    searchable.push(
      createSearchableCatalogTool(candidate.name, candidate.description),
    );
  }

  const allMatches = rankCatalogToolMatches(searchable, words, "all", true);
  if (allMatches.length > 0) return allMatches.slice(0, limit);
  if (words.length <= 1) {
    // Single-word fallback: Levenshtein distance against each word in tool names
    // Use the cleaned word and deduplicated catalog for consistent results
    const levMatches = suggestByLevenshtein(words[0]!, searchable, limit);
    if (levMatches.length > 0) return levMatches;
    return [];
  }
  return rankCatalogToolMatches(searchable, words, "any", true).slice(0, limit);
};

/**
 * Build the JSON-RPC -32602 error message for an in-scope tool that a dynamic
 * catalog has not loaded on this connection. The caller named a real tool, so
 * the recovery is the one call that loads it, not a search.
 */
export const formatUnloadedMcpToolMessage = (requested: string): string =>
  `MCP tool ${requested} is in scope but not loaded on this connection. Call discover_tools with names: [${JSON.stringify(requested)}] to load it and read its input schema, then call it again.`;

/** Maximum Levenshtein distance to consider a match (prevents unrelated suggestions). */
const MAX_LEVENSHTEIN_DISTANCE = 3;
/** Minimum requested name length for Levenshtein fallback (avoids matching very short names). */
const MIN_LEVENSHTEIN_NAME_LENGTH = 6;

/**
 * Compute Levenshtein distance between two strings.
 * Uses optimized O(min(m,n)) space with early exit when distance exceeds maxDistance.
 */
const levenshteinDistance = (
  a: string,
  b: string,
  maxDistance: number,
): number => {
  if (a.length > b.length) return levenshteinDistance(b, a, maxDistance);

  const aLen = a.length;
  const bLen = b.length;

  if (bLen - aLen > maxDistance) return maxDistance + 1;

  let previous: number[] = Array.from({ length: aLen + 1 }, (_, i) => i);

  for (let j = 1; j <= bLen; j += 1) {
    const current: number[] = Array.from({ length: aLen + 1 }, () => 0);
    current[0] = j;
    let minInRow = j;

    for (let i = 1; i <= aLen; i += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[i] = Math.min(
        previous[i] + 1,
        current[i - 1] + 1,
        previous[i - 1] + cost,
      );
      minInRow = Math.min(minInRow, current[i]);
    }
    if (minInRow > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[aLen];
};

/**
 * Find tools with minimal Levenshtein distance to the requested name.
 * Compares against each word within a tool's name/description so multi-part
 * tool names like "decompile_all" can match a typo like "decomplie".
 * Returns tools sorted by distance, then alphabetically.
 */
const suggestByLevenshtein = (
  requested: string,
  candidates: readonly SearchableCatalogTool[],
  limit: number,
  maxDistance = MAX_LEVENSHTEIN_DISTANCE,
): readonly string[] => {
  if (requested.length < MIN_LEVENSHTEIN_NAME_LENGTH) return [];

  const matches: { name: string; distance: number }[] = [];

  for (const candidate of candidates) {
    const words = candidate.name.split(/[\s_-]+/u);
    let bestDistance = maxDistance + 1;
    for (const word of words) {
      const distance = levenshteinDistance(
        requested.toLowerCase(),
        word.toLowerCase(),
        maxDistance,
      );
      if (distance < bestDistance) bestDistance = distance;
    }
    if (bestDistance <= maxDistance) {
      matches.push({ name: candidate.name, distance: bestDistance });
    }
  }

  matches.sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : 1));
  return matches.slice(0, limit).map((m) => m.name);
};
export const formatUnknownMcpToolMessage = (
  requested: string,
  catalog: AdvertisedToolCatalog,
): string => {
  const suggestions = suggestAdvertisedTools(requested, catalog.tools);
  const suggestionClause =
    suggestions.length === 0
      ? undefined
      : suggestions.length === 1
        ? `Closest advertised tool: ${suggestions[0]!}.`
        : `Closest advertised tools: ${suggestions.join(", ")}.`;

  if (catalog.discoveryAvailable) {
    return suggestionClause === undefined
      ? "The requested MCP tool is not advertised by this REA server. Call discover_tools to find and load an in-scope tool, then retry; do not repeat the unknown tool name."
      : `The requested MCP tool is not advertised by this REA server. ${suggestionClause} Select an advertised tool or call discover_tools to find and load other in-scope tools, then retry; do not repeat the unknown tool name.`;
  }

  return suggestionClause === undefined
    ? "The requested MCP tool is not advertised by this REA server. Call tools/list, select an advertised tool, and retry; do not repeat the unknown tool name."
    : `The requested MCP tool is not advertised by this REA server. ${suggestionClause} Select an advertised tool or call tools/list, and retry; do not repeat the unknown tool name.`;
};
