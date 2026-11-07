import {
  auditReleaseExposureInputSchema,
  releaseExposureReportSchema,
} from "../domain/releaseExposure.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

/** Read-only report of what static analysis recovers from one shipped artifact. */
export const RELEASE_EXPOSURE_TOOL_CONTRACTS = [
  {
    name: "audit_release_exposure",
    ...toolContractMetadata("audit_release_exposure"),
    kind: "artifact-provider",
    description:
      "Report what static analysis of a shipped application artifact recovers. Accepts one local .app bundle, installation directory, ASAR, or executable. Each check has a stable id, a status, the observation behind it, and fixed remediation text. Unknown and unassessed checks stay in the report. This does not establish that an application is secure. Reads the selected artifact. When the selection is a file, the parent directory is listed for sibling .pdb, .dSYM, .debug, and .map debug companions.",
    inputSchema: auditReleaseExposureInputSchema,
    outputSchema: evidenceResultOf(releaseExposureReportSchema),
    examples: [
      {
        title: "Audit a shipped application",
        input: { path: "/artifacts/MyApp.app" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
