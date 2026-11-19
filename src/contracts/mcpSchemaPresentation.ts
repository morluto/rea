import { ADVERTISED_INPUT_SCHEMA_MAX_BYTES } from "./advertisedDialect.js";
import type { AdvertisedToolPresentation } from "./advertisedTool.js";
import type { CompactInputSchemaPresentation } from "./compactInputSchema.js";

// The presentations REA's MCP catalog advertises. Configuration parses the
// caller's selection into these names; the catalog identity, servers and
// client verifiers present schemas through them.

/** The compact presentation fits the portable dialect's per-tool size cap. */
export const COMPACT_INPUT_SCHEMA_BUDGET_BYTES =
  ADVERTISED_INPUT_SCHEMA_MAX_BYTES;

/**
 * The one advertised input presentation. Every server, identity and recorded
 * catalog presents input schemas through it; canonical validators still
 * check every call.
 */
export const COMPACT_INPUT_SCHEMA_PRESENTATION: CompactInputSchemaPresentation =
  Object.freeze({ budgetBytes: COMPACT_INPUT_SCHEMA_BUDGET_BYTES });

/**
 * Per-schema budget for compact output advertisements. Output contracts are
 * larger than input contracts across the catalog, and the complete frame is
 * what a frame-capped host rejects. Measured on the complete contract catalog
 * with the default compact input profile, 4 KiB bounds the output
 * advertisement to ~276 KiB and the complete `tools/list` response to
 * ~577 KiB, leaving margin under the one-megabyte frame reported in #2512. A
 * larger budget admits substantially more full contracts; a much smaller one
 * drops first-level property guidance for nearly every tool.
 */
export const COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES = 4 * 1024;

/** The output schema advertisements a catalog can select. */
export const MCP_OUTPUT_SCHEMA_PROFILES = ["off", "compact"] as const;

export type McpOutputSchemaProfile =
  (typeof MCP_OUTPUT_SCHEMA_PROFILES)[number];

/**
 * Resolve the selected advertisement. No model API reads an output schema;
 * MCP client validators re-check what REA already validates, and complete
 * output schemas were about 92% of `tools/list`. They are therefore omitted
 * unless a caller selects `compact`.
 */
export const resolveMcpOutputSchemaProfile = (
  profile: McpOutputSchemaProfile | undefined,
): McpOutputSchemaProfile => profile ?? "off";

/** The one bounded output advertisement, selected by `compact`. */
export const COMPACT_OUTPUT_SCHEMA_PRESENTATION: {
  readonly budgetBytes: number;
} = Object.freeze({ budgetBytes: COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES });

/** How REA's MCP catalog advertises its tools for a selected output profile. */
export const advertisedToolPresentation = (
  outputSchemaProfile: McpOutputSchemaProfile,
  input: CompactInputSchemaPresentation = COMPACT_INPUT_SCHEMA_PRESENTATION,
): AdvertisedToolPresentation => ({
  input: { budgetBytes: input.budgetBytes },
  output:
    outputSchemaProfile === "compact"
      ? COMPACT_OUTPUT_SCHEMA_PRESENTATION
      : undefined,
});
