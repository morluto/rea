import { createHash } from "node:crypto";
import { z } from "zod";
import type { createCatalogIdentity } from "./catalogIdentity.js";

export const HOT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "binary_session",
  "open_binary",
  "close_binary",
  "get_evidence_bundle",
  "inspect_analysis_view",
]);

// One page activates at most 20 schemas: callers can page a broad search instead
// of inadvertently expanding the entire catalog into their client's context.
const pageSize = z.int().min(1).max(20).default(3);
const inputSchema = z
  .strictObject({
    query: z
      .string()
      .trim()
      .optional()
      .describe(
        "Case-insensitive words matched against tool names and descriptions; all words must match. Omit to browse.",
      ),
    names: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .optional()
      .describe("Exact tool names to load instead of searching."),
    offset: z.int().min(0).default(0),
    limit: pageSize.describe(
      "Search page size; does not apply to exact names.",
    ),
  })
  .refine(
    (input) =>
      input.names === undefined ||
      (input.query === undefined && input.offset === 0),
    {
      message: "Use names alone, or query with offset/limit.",
    },
  );
const outputSchema = z.strictObject({
  profile: z.literal("hot-cold"),
  inventory_count: z.int().nonnegative(),
  loaded_count: z.int().nonnegative(),
  total_matches: z.int().nonnegative(),
  next_offset: z.int().nonnegative().nullable(),
  tools: z.array(
    z.strictObject({
      name: z.string(),
      description: z
        .string()
        .describe(
          "Abbreviated canonical description; read tools/list for the complete contract.",
        ),
      input_schema: z
        .record(z.string(), z.unknown())
        .describe(
          "The configured advertised input schema for calling this named tool.",
        ),
    }),
  ),
  next_step: z.string(),
});

export const DISCOVER_TOOLS = {
  name: "discover_tools",
  description:
    "Find and load REA tools on demand. Search by task keywords (for example javascript, sqlite, strings, imports), or supply exact names. Returned tools become callable with their original names and full schemas after your client refreshes tools/list. Loaded tools remain available for this connection. This only changes catalog visibility; it does not run analysis or grant execution authority. If tools do not appear, enable MCP catalog refresh in your client or use REA_MCP_TOOL_CATALOG_PROFILE=full.",
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export type CatalogIdentity = ReturnType<typeof createCatalogIdentity>;
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Identity covers the discoverable inventory and policy, not mutable visibility. */
export const progressiveCatalogIdentity = (
  base: CatalogIdentity,
): CatalogIdentity => {
  const policy = {
    profile: "hot-cold",
    hot: [...HOT_TOOL_NAMES],
    tool: {
      ...DISCOVER_TOOLS,
      inputSchema: z.toJSONSchema(inputSchema, { io: "input" }),
      outputSchema: z.toJSONSchema(outputSchema),
    },
  };
  const tools_sha256 = digest({ base: base.digests.tools_sha256, policy });
  return {
    counts: { ...base.counts, mcp_tools: base.counts.mcp_tools + 1 },
    digests: {
      tools_sha256,
      prompts_sha256: base.digests.prompts_sha256,
      combined_sha256: digest({
        base: base.digests.combined_sha256,
        tools_sha256,
      }),
    },
  };
};
