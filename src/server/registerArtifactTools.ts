import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";

import {
  ARTIFACT_TOOL_CONTRACTS,
  artifactInspectionInputSchema,
} from "../contracts/artifactToolContracts.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { summarizeRetainedAnalysis } from "../application/analysisView/AnalysisViewService.js";
import { createArtifactExtractionDestination } from "../application/artifacts/ArtifactExtractionDestination.js";
import { ok } from "../domain/result.js";
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
    readonly evidenceById?: EvidenceLookup | undefined;
    readonly withAdmittedAnalysis: import("./analysisAdmission.js").WithAdmittedAnalysis;
  },
): void => {
  registerEvidenceTools(server, ARTIFACT_TOOL_CONTRACTS, {
    ...options,
    parametersForExecution: (operation, parameters) => {
      if (operation === "inspect_artifact") {
        const { detail: _detail, ...execution } =
          artifactInspectionInputSchema.parse(parameters);
        return execution;
      }
      return operation === "extract_artifact"
        ? { ...parameters, output_root: createArtifactExtractionDestination() }
        : parameters;
    },
    projectEvidence: (operation, parameters, evidence) =>
      operation === "inspect_artifact" && parameters.detail === "summary"
        ? summarizeRetainedAnalysis(evidence, {
            recordEvidence: options.recordEvidence,
            evidenceById: options.evidenceById,
          })
        : ok(evidence),
    sourceEvidence: (operation, result) =>
      operation === "inspect_artifact"
        ? artifactInspectionResultSchema
            .parse(result)
            .substeps.map(({ evidence }) => evidence)
        : [],
  });
};
