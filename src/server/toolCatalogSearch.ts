/** One currently advertised MCP tool that discovery or unknown-tool hints may examine. */
export interface AdvertisedToolDescriptor {
  readonly name: string;
  readonly description?: string | undefined;
}

/** Live advertisement snapshot consulted when a tools/call names an unknown tool. */
export interface AdvertisedToolCatalog {
  readonly tools: readonly AdvertisedToolDescriptor[];
  readonly discoveryAvailable: boolean;
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
  mode: "all" | "any" = "all",
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
    const nameLower = tool.name.toLowerCase();
    let nameScore = 0;
    for (let i = 0; i < words.length; i += 1) {
      if (nameLower.includes(words[i]!)) nameScore += 1;
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
  if (words.length <= 1) return [];
  return rankCatalogToolMatches(searchable, words, "any", true).slice(0, limit);
};

/** Build the JSON-RPC -32602 error message for an unadvertised MCP tool name. */
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
