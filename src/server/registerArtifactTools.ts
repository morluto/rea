import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";

import { ARTIFACT_TOOL_CONTRACTS } from "../contracts/artifactToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { Logger } from "pino";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import { artifactInspectionResultSchema } from "../domain/artifactInspection.js";

/** Register deterministic artifact inventory and safe extraction operations. */
export const registerArtifactTools = (
  server: EvidenceMcpServer,
  options: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly withAdmittedAnalysis: import("./analysisAdmission.js").WithAdmittedAnalysis;
  },
): void => {
  registerEvidenceTools(server, ARTIFACT_TOOL_CONTRACTS, {
    ...options,
    sourceEvidence: (operation, result) =>
      operation === "inspect_artifact"
        ? artifactInspectionResultSchema
            .parse(result)
            .substeps.map(({ evidence }) => evidence)
        : [],
  });
};
