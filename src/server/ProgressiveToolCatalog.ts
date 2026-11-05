import type { RegisteredTool } from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
  DISCOVER_TOOLS,
  HOT_TOOL_NAMES,
  progressiveCatalogIdentity,
  type CatalogIdentity,
} from "../catalogDiscovery.js";

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
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              code: "unknown_tools",
              names: unknown,
              remediation:
                "Search with query to find exact in-scope names. No tools were loaded.",
            }),
          },
        ],
      };
    const words = (input.query ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    const matches =
      names ??
      [...this.tools]
        .filter(([, tool]) => words.every((word) => tool.search.includes(word)))
        .map(([name]) => name)
        .sort((left, right) => {
          const score = (name: string) =>
            words.filter((word) => name.includes(word)).length;
          return (
            score(right) - score(left) ||
            (left < right ? -1 : left > right ? 1 : 0)
          );
        });
    const page =
      names ?? matches.slice(input.offset, input.offset + input.limit);
    const selected = page.map((name) => ({ name, ...this.tools.get(name)! }));
    this.batchChanges(() => {
      for (const { registered } of selected) {
        if (!registered.enabled) registered.enable();
      }
    });
    const result: z.infer<typeof DISCOVER_TOOLS.outputSchema> = {
      profile: "hot-cold",
      inventory_count: this.tools.size + 1,
      loaded_count:
        1 +
        [...this.tools.values()].filter(({ registered }) => registered.enabled)
          .length,
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
          ? "No matches. Try fewer or different task keywords, or browse without query."
          : "Call the returned tool by its original name using input_schema. Your client must refresh tools/list first; if it cannot, reconnect with REA_MCP_TOOL_CATALOG_PROFILE=full.",
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }
}
