import type { McpServer } from "@modelcontextprotocol/server";

import { registerTraceFeatureTool } from "./registerApplicationTools/traceFeature.js";
import { registerCompareApplicationVersionsTool } from "./registerApplicationTools/compareVersions.js";
import { registerCompareJavaScriptExportShapesTool } from "./registerApplicationTools/compareExportShapes.js";
import { registerControlledReplayTool } from "./registerApplicationTools/controlledReplay.js";
import { registerCharacterizationTools } from "./registerApplicationTools/characterization.js";
import { registerCoverageTools } from "./registerApplicationTools/coverage.js";
import type { ApplicationToolRegistration } from "./registerApplicationTools/types.js";

export type { ApplicationToolRegistration };

/** Register provider-neutral JavaScript application graph workflows. */
export const registerApplicationTools = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  registerTraceFeatureTool(server, options);
  registerCompareApplicationVersionsTool(server, options);
  registerCompareJavaScriptExportShapesTool(server, options);
  registerControlledReplayTool(server, options);
  registerCharacterizationTools(server, options);
  registerCoverageTools(server, options);
};
