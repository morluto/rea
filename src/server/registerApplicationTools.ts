import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { registerCoverageTools } from "./registerApplicationTools/coverage.js";
import { registerEnvironmentBundleTool } from "./registerApplicationTools/environmentBundle.js";
import type { ApplicationToolRegistration } from "./registerApplicationTools/types.js";
import { registerGuidedWorkflowTool } from "./registerGuidedWorkflowTool.js";

/**
 * Register the application tools that deliver plain results. Application
 * workflows that complete Evidence are bound through the shared table
 * (`applicationWorkflows` in serviceToolBindings.ts).
 */
export const registerApplicationTools = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  registerGuidedWorkflowTool(server);
  registerCoverageTools(server, options);
  registerEnvironmentBundleTool(server, options);
};
