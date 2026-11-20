import { z } from "zod";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Full advertisement remains the default for clients without catalog refresh. */
export const mcpToolCatalogProfileSchema = z.enum(["full", "hot-cold"]);
export type McpToolCatalogProfile = z.infer<typeof mcpToolCatalogProfileSchema>;

export const parseMcpToolCatalogProfile = (
  value: string | undefined,
): Result<McpToolCatalogProfile | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = mcpToolCatalogProfileSchema.safeParse(value);
  const constraint =
    'REA_MCP_TOOL_CATALOG_PROFILE must be "full" (default) or "hot-cold". Hot/cold requires a client that refreshes tools after notifications/tools/list_changed.';
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(constraint, {
          settings: [{ setting: "REA_MCP_TOOL_CATALOG_PROFILE", constraint }],
        }),
      );
};
