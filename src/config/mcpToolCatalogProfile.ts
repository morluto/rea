import { z } from "zod";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import type { Result } from "../domain/result.js";
import { parseOptionalMcpSetting } from "./optionalMcpSetting.js";

/** Full advertisement remains the default for clients without catalog refresh. */
export const mcpToolCatalogProfileSchema = z.enum(["full", "hot-cold"]);
export type McpToolCatalogProfile = z.infer<typeof mcpToolCatalogProfileSchema>;

const constraint =
  'REA_MCP_TOOL_CATALOG_PROFILE must be "full" (default) or "hot-cold". Hot/cold requires a client that refreshes tools after notifications/tools/list_changed.';

export const parseMcpToolCatalogProfile = (
  value: string | undefined,
): Result<McpToolCatalogProfile | undefined, ConfigurationError> =>
  parseOptionalMcpSetting(
    value,
    mcpToolCatalogProfileSchema,
    "REA_MCP_TOOL_CATALOG_PROFILE",
    constraint,
  );
