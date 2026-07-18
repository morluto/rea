import type { McpServer } from "@modelcontextprotocol/server";

import { registerCompareManagedMembers } from "./registerManagedWorkflowTools/compareManagedMembers.js";
import { registerVerifyManagedNativeBoundaries } from "./registerManagedWorkflowTools/verifyManagedNativeBoundaries.js";
import { registerImportManagedReconstruction } from "./registerManagedWorkflowTools/importManagedReconstruction.js";
import { registerPlanManagedRuntimeCorrelation } from "./registerManagedWorkflowTools/planManagedRuntimeCorrelation.js";
import { registerProjectManagedApplicationGraph } from "./registerManagedWorkflowTools/projectManagedApplicationGraph.js";
import type { ManagedWorkflowToolRegistration } from "./registerManagedWorkflowTools/types.js";

export type { ManagedWorkflowToolRegistration };

/** Register provider-neutral managed-code workflows. */
export const registerManagedWorkflowTools = (
  server: McpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  registerCompareManagedMembers(server, options);
  registerVerifyManagedNativeBoundaries(server, options);
  registerImportManagedReconstruction(server, options);
  registerPlanManagedRuntimeCorrelation(server, options);
  registerProjectManagedApplicationGraph(server, options);
};
