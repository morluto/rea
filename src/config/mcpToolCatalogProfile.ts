import { z } from "zod";
import { optionalSettingParser } from "./optionalSetting.js";

/** Full advertisement remains the default for clients without catalog refresh. */
export const mcpToolCatalogProfileSchema = z.enum(["full", "hot-cold"]);
export type McpToolCatalogProfile = z.infer<typeof mcpToolCatalogProfileSchema>;

export const parseMcpToolCatalogProfile = optionalSettingParser(
  "REA_MCP_TOOL_CATALOG_PROFILE",
  mcpToolCatalogProfileSchema,
  'REA_MCP_TOOL_CATALOG_PROFILE must be "full" (default) or "hot-cold". Hot/cold requires a client that refreshes tools after notifications/tools/list_changed.',
);
