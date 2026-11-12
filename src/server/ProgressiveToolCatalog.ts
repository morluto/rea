import type { RegisteredTool } from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ownedJsonObjectSchema } from "../domain/jsonValue.js";
import { encodeToolResult } from "./toolResultEncoding.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import {
  DISCOVER_TOOLS,
  HOT_TOOL_NAMES,
  progressiveCatalogIdentity,
  type CatalogIdentity,
} from "../catalogDiscovery.js";

const DISCOVERY_PREVIEW_CHARS = 240;
const OPENING_CHARS = 160;

const indexesOf = (text: string, word: string): number[] => {
  const found: number[] = [];
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(word, from);
    if (index < 0) return found;
    found.push(index);
    from = index + word.length;
  }
  return found;
};

/** A nearby not/without governs this mention. "imports without execution" does not. */
const negatedAt = (lower: string, index: number): boolean => {
  const clauseStart = Math.max(
    lower.lastIndexOf(".", index - 1) + 1,
    index - 80,
  );
  if (/\b(not|never|without|no)\b/u.test(lower.slice(clauseStart, index)))
    return true;
  return /\b(?:is|are|was|were|does|do|did|cannot|can)\s+not\b/u.test(
    lower.slice(index, index + 32),
  );
};

const openingOf = (description: string): string => {
  const mark = /[.!?](?=\s|$)/u.exec(description);
  const sentence =
    mark === null ? description : description.slice(0, mark.index + 1);
  return sentence.length <= OPENING_CHARS
    ? sentence
    : sentence.slice(0, OPENING_CHARS);
};

const excerptAround = (
  description: string,
  hit: number,
  room: number,
): string => {
  const lower = description.toLowerCase();
  const sentenceStart = lower.lastIndexOf(".", hit - 1) + 1;
  const negationAt = [" not ", " without ", " never ", " no "]
    .map((mark) => lower.lastIndexOf(mark, hit))
    .reduce((earliest, index) => Math.max(earliest, index), -1);
  const start =
    negationAt >= sentenceStart && hit - negationAt <= 80
      ? negationAt + 1
      : Math.max(0, hit - 24);
  const excerpt = description.slice(start, hit + room);
  return excerpt.length <= room
    ? excerpt
    : excerpt.slice(excerpt.length - room);
};

/** The opening task stays. A query word past 240 is appended, not substituted. */
export const discoveryPreview = (
  description: string,
  words: readonly string[],
): string => {
  if (description.length <= DISCOVERY_PREVIEW_CHARS) return description;
  const lower = description.toLowerCase();
  const hidden = words
    .flatMap((word) => indexesOf(lower, word))
    .filter((index) => index >= DISCOVERY_PREVIEW_CHARS);
  if (hidden.length === 0) return description.slice(0, DISCOVERY_PREVIEW_CHARS);
  const separator = " … ";
  const opening = openingOf(description).slice(
    0,
    DISCOVERY_PREVIEW_CHARS - separator.length - 48,
  );
  const room = DISCOVERY_PREVIEW_CHARS - opening.length - separator.length;
  return `${opening}${separator}${excerptAround(description, Math.min(...hidden), room)}`;
};

const nameToken = (name: string, word: string): boolean =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .includes(word);

const placement = (name: string, description: string, word: string): number => {
  if (nameToken(name, word)) return 4;
  const lower = description.toLowerCase();
  const hits = indexesOf(lower, word);
  const affirmative = hits.filter((index) => !negatedAt(lower, index));
  if (affirmative.length === 0) return hits.length === 0 ? 0 : 1;
  return Math.min(...affirmative) < DISCOVERY_PREVIEW_CHARS ? 3 : 2;
};

const rankScore = (
  name: string,
  description: string,
  words: readonly string[],
): number =>
  words.reduce((sum, word) => sum + placement(name, description, word), 0);

const earliestAffirmative = (
  description: string,
  words: readonly string[],
): number => {
  const lower = description.toLowerCase();
  return words.reduce((earliest, word) => {
    const live = indexesOf(lower, word).filter(
      (index) => !negatedAt(lower, index),
    );
    const index =
      live.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...live);
    return Math.min(earliest, index);
  }, Number.MAX_SAFE_INTEGER);
};

const compareDiscoveryNames = (
  left: string,
  right: string,
  words: readonly string[],
  descriptions: ReadonlyMap<string, { description: string }>,
): number => {
  const leftDescription = descriptions.get(left)?.description ?? "";
  const rightDescription = descriptions.get(right)?.description ?? "";
  const score =
    rankScore(right, rightDescription, words) -
    rankScore(left, leftDescription, words);
  if (score !== 0) return score;
  const named = (name: string) =>
    words.filter((word) => nameToken(name, word)).length;
  if (named(left) > 0 && named(left) === named(right))
    return left < right ? -1 : left > right ? 1 : 0;
  const position =
    earliestAffirmative(leftDescription, words) -
    earliestAffirmative(rightDescription, words);
  return position !== 0 ? position : left < right ? -1 : left > right ? 1 : 0;
};

/** Per-connection visibility; canonical SDK handles retain validation and authority. */
export class ProgressiveToolCatalog {
  readonly identity: CatalogIdentity;
  private readonly tools: ReadonlyMap<
    string,
    { registered: RegisteredTool; description: string; search: string }
  >;

  constructor(
    registrations: ReadonlyMap<string, RegisteredTool>,
    identity: CatalogIdentity,
    private readonly batchChanges: (change: () => void) => void,
    private readonly delivery: () => ToolResultDelivery,
  ) {
    this.identity = progressiveCatalogIdentity(identity);
    // Disabled family registrations are outside the discoverable scope. Never
    // let discovery re-enable a tool the caller excluded from this server.
    this.tools = new Map(
      [...registrations]
        .filter(([, tool]) => tool.enabled)
        .map(([name, registered]) => [
          name,
          {
            registered,
            description: registered.description ?? "",
            search:
              `${name} ${name.replaceAll("_", " ")} ${registered.description ?? ""}`.toLowerCase(),
          },
        ]),
    );
    this.reset();
  }

  /** A reused HTTP server starts each new transport with the hot inventory. */
  reset(): void {
    this.batchChanges(() => {
      for (const [name, { registered }] of this.tools) {
        if (registered.enabled && !HOT_TOOL_NAMES.has(name))
          registered.disable();
      }
    });
  }

  discover(input: z.infer<typeof DISCOVER_TOOLS.inputSchema>) {
    const names =
      input.names === undefined ? undefined : [...new Set(input.names)];
    const unknown = names?.filter((name) => !this.tools.has(name)) ?? [];
    if (unknown.length > 0)
      return this.delivery().toErrorToolResult(
        new AnalysisInputError(
          DISCOVER_TOOLS.name,
          {
            userMessage:
              "Unknown or excluded tool names. No tools were loaded.",
            remediationAction:
              "Search with query to find exact in-scope names.",
            conformsToInputContract: true,
          },
          unknown.map((name) => ({
            path: ["names"],
            reason: "invalid_value",
            message: name,
          })),
        ),
        false,
      );
    const words = (input.query ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    const matches =
      names ??
      [...this.tools]
        .filter(([, tool]) => words.every((word) => tool.search.includes(word)))
        .map(([name]) => name)
        .sort((left, right) =>
          compareDiscoveryNames(left, right, words, this.tools),
        );
    const page =
      names ?? matches.slice(input.offset, input.offset + input.limit);
    const selected = page.map((name) => ({ name, ...this.tools.get(name)! }));
    const result: z.infer<typeof DISCOVER_TOOLS.outputSchema> = {
      profile: "hot-cold",
      inventory_count: this.tools.size + 1,
      loaded_count:
        1 +
        [...this.tools.values()].filter(({ registered }) => registered.enabled)
          .length +
        selected.filter(({ registered }) => !registered.enabled).length,
      total_matches: matches.length,
      next_offset:
        names === undefined && input.offset + page.length < matches.length
          ? input.offset + page.length
          : null,
      tools: selected.map(({ name, description, registered }) => ({
        name,
        description: discoveryPreview(description, words),
        input_schema: registered.inputSchema?.["~standard"].jsonSchema.input({
          target: "draft-2020-12",
        }) ?? { type: "object" },
      })),
      next_step:
        selected.length === 0
          ? matches.length === 0
            ? "No matches. Try fewer or different task keywords, or browse without query."
            : "No remaining matches at this offset. Use offset 0 to restart this query, or select an earlier offset."
          : "Call the returned tool by its original name using input_schema. Your client must refresh tools/list first; if it cannot, reconnect with REA_MCP_TOOL_CATALOG_PROFILE=full.",
    };
    // This reply borrows read-only SDK schema projections for synchronous
    // encoding; validate the new reply without copying their complete trees.
    const payload = ownedJsonObjectSchema.parse(result);
    const delivery = this.delivery();
    const encoded = encodeToolResult(payload, delivery.resultBudgetBytes);
    if (!encoded.ok)
      return delivery.toErrorToolResult(
        new AnalysisResourceConstraintError(
          DISCOVER_TOOLS.name,
          "transport",
          "The discovery page exceeds the reply budget. No tools were loaded.",
          {
            result_budget_bytes: delivery.resultBudgetBytes,
            response_bytes_at_least: encoded.bytesAtLeast,
            constraint: encoded.constraint,
          },
          {
            remediationAction:
              "Reduce limit or request fewer exact names, then retry. For one oversized input contract, reconnect with REA_MCP_INPUT_SCHEMA_PROFILE=compact.",
          },
        ),
        false,
      );
    // Visibility changes only after both reply representations fit. A failed
    // page can be retried without silently enabling unreported definitions.
    this.batchChanges(() => {
      for (const { registered } of selected) {
        if (!registered.enabled) registered.enable();
      }
    });
    return {
      content: [{ type: "text" as const, text: encoded.text }],
      structuredContent: payload,
    };
  }
}
