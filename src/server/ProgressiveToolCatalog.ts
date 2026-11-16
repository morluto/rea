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
} from "../contracts/catalog/catalogDiscovery.js";

/**
 * Order in-scope tools for a discovery query. Tools matching every word come
 * first, by words found in the name and then by name, so a query that matched
 * under all-words search keeps the same leading results. Tools matching only
 * some words follow, weighted by how rare each matched word is in the in-scope
 * inventory: a query naming several attributes still finds each attribute's
 * tool, while words that most descriptions contain carry little weight.
 */
const rankDiscoveryMatches = (
  tools: ReadonlyMap<string, { readonly search: string }>,
  words: readonly string[],
): string[] => {
  const candidates = [...tools].map(([name, { search }]) => ({
    name,
    matched: words.filter((word) => search.includes(word)),
  }));
  const rarity = new Map(
    words.map((word) => {
      const containing = candidates.filter(({ matched }) =>
        matched.includes(word),
      ).length;
      return [word, Math.log((candidates.length + 1) / (containing + 1))];
    }),
  );
  return candidates
    .filter(({ matched }) => words.length === 0 || matched.length > 0)
    .map(({ name, matched }) => ({
      name,
      complete: matched.length === words.length,
      weight: matched.reduce((sum, word) => sum + rarity.get(word)!, 0),
      inName: words.filter((word) => name.includes(word)).length,
    }))
    .sort(
      (left, right) =>
        Number(right.complete) - Number(left.complete) ||
        right.weight - left.weight ||
        right.inName - left.inName ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    )
    .map(({ name }) => name);
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
            description: (registered.description ?? "").slice(0, 240),
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
    const words = [
      ...new Set((input.query ?? "").toLowerCase().split(/\s+/u)),
    ].filter(Boolean);
    const matches = names ?? rankDiscoveryMatches(this.tools, words);
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
        description,
        input_schema: registered.inputSchema?.["~standard"].jsonSchema.input({
          target: "draft-2020-12",
        }) ?? { type: "object" },
      })),
      next_step:
        selected.length === 0
          ? matches.length === 0
            ? "No matches. Try different task keywords, or browse without query."
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
              "Reduce limit or request fewer exact names, then retry.",
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
