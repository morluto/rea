import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

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

/** Select whether tools/list carries the large output contracts. */
export const mcpOutputSchemaProfileSchema = z.enum(["full", "compact", "off"]);

export type McpOutputSchemaProfile = z.infer<
  typeof mcpOutputSchemaProfileSchema
>;

/**
 * Resolve the selected advertisement at the configuration boundary. No model
 * API reads an output schema; MCP client validators re-check what REA already
 * validates, and complete output schemas were about 92% of `tools/list`. They
 * are therefore omitted unless a caller selects `compact` or `full`.
 */
export const resolveMcpOutputSchemaProfile = (
  profile: McpOutputSchemaProfile | undefined,
): McpOutputSchemaProfile => profile ?? "off";

/** Resolve the compact output advertisement, preserving every other choice. */
export const compactPresentationForMcpOutputSchemaProfile = (
  profile: McpOutputSchemaProfile | undefined,
): { readonly budgetBytes: number } | undefined =>
  profile === "compact"
    ? { budgetBytes: COMPACT_OUTPUT_SCHEMA_BUDGET_BYTES }
    : undefined;

const profileConstraint =
  'REA_MCP_OUTPUT_SCHEMA_PROFILE must be "off" (default), "compact", or "full". The off profile omits output schemas; compact advertises every output schema within a 4,096-byte budget; full advertises complete output schemas. All keep canonical server-side validation and complete structured content.';

/** Parse the output schema advertisement selection at server composition. */
export const parseMcpOutputSchemaProfile = (
  value: string | undefined,
): Result<McpOutputSchemaProfile | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = mcpOutputSchemaProfileSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(profileConstraint, {
          settings: [
            {
              setting: "REA_MCP_OUTPUT_SCHEMA_PROFILE",
              constraint: profileConstraint,
            },
          ],
        }),
      );
};
