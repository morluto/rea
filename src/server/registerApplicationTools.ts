import { registerPlaywrightTraceTool } from "./registerApplicationTools/playwrightTrace.js";
import { registerApiContractTool } from "./registerApplicationTools/apiContract.js";
import { registerWarcArchiveTool } from "./registerApplicationTools/warcArchive.js";
import { registerNtfsJournalTool } from "./registerApplicationTools/ntfsJournal.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import { registerTraceFeatureTool } from "./registerApplicationTools/traceFeature.js";
import { registerTraceJavaScriptSemanticsTool } from "./registerApplicationTools/traceSemantics.js";
import { registerCompareApplicationVersionsTool } from "./registerApplicationTools/compareVersions.js";
import { registerCompareEndpointsTool } from "./registerApplicationTools/compareEndpoints.js";
import { registerCompareSourceToBundleTool } from "./registerApplicationTools/compareSourceToBundle.js";
import { registerCompareJavaScriptExportShapesTool } from "./registerApplicationTools/compareExportShapes.js";
import { registerCoverageTools } from "./registerApplicationTools/coverage.js";
import { registerEnvironmentBundleTool } from "./registerApplicationTools/environmentBundle.js";
import { registerReconstructionObligationLedgerTool } from "./registerApplicationTools/obligationLedger.js";
import { registerProjectMobileApplicationGraphTools } from "./registerApplicationTools/projectMobileApplicationGraph.js";
import type { ApplicationToolRegistration } from "./registerApplicationTools/types.js";
import { registerGuidanceTools } from "./registerGuidanceTools.js";
import { registerGuidedWorkflowTool } from "./registerGuidedWorkflowTool.js";

/** Register provider-neutral JavaScript application graph workflows. */
export const registerApplicationTools = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  registerGuidanceTools(server, options.artifactResources);
  registerGuidedWorkflowTool(server);
  registerTraceFeatureTool(server, options);
  registerTraceJavaScriptSemanticsTool(server, options);
  registerCompareApplicationVersionsTool(server, options);
  registerCompareEndpointsTool(server, options);
  registerApiContractTool(server, options);
  registerWarcArchiveTool(server, options);
  registerNtfsJournalTool(server, options);
  registerPlaywrightTraceTool(server, options);
  registerCompareSourceToBundleTool(server, options);
  registerCompareJavaScriptExportShapesTool(server, options);
  registerReconstructionObligationLedgerTool(server, options);
  registerCoverageTools(server, options);
  registerEnvironmentBundleTool(server, options);
  registerProjectMobileApplicationGraphTools(server, options);
};
