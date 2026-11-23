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

type CatalogListing = {
  registered: RegisteredTool;
  description: string;
  fullDescription: string;
};
const catalogListing = (registered: RegisteredTool): CatalogListing => {
  const fullDescription = registered.description ?? "";
  return {
    registered,
    description: fullDescription.slice(0, 240),
    fullDescription,
  };
};

/** Per-connection visibility; canonical SDK handles retain validation and authority. */
export class ProgressiveToolCatalog {
  readonly identity: CatalogIdentity;
  /** In-scope domain tools; the adapter is never a search result or reset. */
  private readonly tools: ReadonlyMap<
    string,
    CatalogListing & { search: string }
  >;
  /** Exact names and counts also cover the always-advertised adapter. */
  private readonly inventory: ReadonlyMap<string, CatalogListing>;
  private readonly inputSchemas = new WeakMap<
    RegisteredTool,
    Record<string, unknown>
  >();

  constructor(
    registrations: ReadonlyMap<string, RegisteredTool>,
    adapter: RegisteredTool,
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
            ...catalogListing(registered),
            search:
              `${name} ${name.replaceAll("_", " ")} ${registered.description ?? ""}`.toLowerCase(),
          },
        ]),
    );
    this.inventory = new Map<string, CatalogListing>([
      ...this.tools,
      [DISCOVER_TOOLS.name, catalogListing(adapter)],
    ]);
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

  private inputSchemaFor(registered: RegisteredTool): Record<string, unknown> {
    let schema = this.inputSchemas.get(registered);
    if (schema === undefined) {
      schema = (registered.inputSchema?.["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      }) as Record<string, unknown> | undefined) ?? { type: "object" };
      this.inputSchemas.set(registered, schema);
    }
    return schema;
  }

  private rankMatches(query: string | undefined): readonly string[] {
    const words = (query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
    const ranked: { readonly name: string; readonly score: number }[] = [];
    for (const [name, tool] of this.tools) {
      let matchesAll = true;
      for (let i = 0; i < words.length; i++) {
        if (!tool.search.includes(words[i]!)) {
          matchesAll = false;
          break;
        }
      }
      if (!matchesAll) continue;
      let score = 0;
      for (let i = 0; i < words.length; i++) {
        if (name.includes(words[i]!)) score += 1;
      }
      ranked.push({ name, score });
    }
    ranked.sort(
      (left, right) =>
        right.score - left.score ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );
    return ranked.map((entry) => entry.name);
  }

  discover(input: z.infer<typeof DISCOVER_TOOLS.inputSchema>) {
    const names =
      input.names === undefined ? undefined : [...new Set(input.names)];
    const unknown = names?.filter((name) => !this.inventory.has(name)) ?? [];
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
    const matches = names ?? this.rankMatches(input.query);
    const page =
      names ?? matches.slice(input.offset, input.offset + input.limit);
    const selected = page.map((name) => ({
      name,
      ...this.inventory.get(name)!,
    }));
    let loadedCount = 0;
    for (const { registered } of this.inventory.values()) {
      if (registered.enabled) loadedCount += 1;
    }
    for (let i = 0; i < selected.length; i++) {
      if (!selected[i]!.registered.enabled) loadedCount += 1;
    }
    const result: z.infer<typeof DISCOVER_TOOLS.outputSchema> = {
      profile: "hot-cold",
      inventory_count: this.inventory.size,
      loaded_count: loadedCount,
      total_matches: matches.length,
      next_offset:
        names === undefined && input.offset + page.length < matches.length
          ? input.offset + page.length
          : null,
      tools: selected.map(
        ({ name, description, fullDescription, registered }) => ({
          name,
          description: names !== undefined ? fullDescription : description,
          input_schema: this.inputSchemaFor(registered),
        }),
      ),
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
