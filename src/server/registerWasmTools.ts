import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { WasmArtifactService } from "../application/wasm/WasmArtifactService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { summarizeRetainedAnalysis } from "../application/analysisView/AnalysisViewService.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err } from "../domain/result.js";
import { wasmArtifactModule } from "../composition/wasm.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind the named WASM contract to shared validation and session Evidence recording. */
export const registerWasmTools = (
  server: EvidenceMcpServer,
  service: Pick<WasmArtifactService, "inspect">,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
  evidenceById?: EvidenceLookup,
): void => {
  const contract = wasmArtifactModule.contract;
  const handler = createEvidenceToolHandler(
    server,
    async (rawInput, options) => {
      const parsed = contract.inputSchema.safeParse(rawInput);
      if (!parsed.success)
        return err(
          analysisInputErrorFromIssues(
            contract.name,
            parsed.error.issues,
            rawInput,
            { cause: parsed.error },
          ),
        );
      const { detail, ...input } = parsed.data;
      const inspected = await service.inspect(input, options);
      return detail === "summary" && inspected.ok
        ? summarizeRetainedAnalysis(inspected.value, {
            recordEvidence,
            evidenceById,
          })
        : inspected;
    },
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};
