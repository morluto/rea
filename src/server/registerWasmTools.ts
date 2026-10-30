import { compareWasmInterfaces } from "../application/wasm/WasmInterfaceComparisonService.js";
import { COMPARE_WASM_INTERFACES_CONTRACT } from "../contracts/wasm/wasmComparisonContracts.js";
import { resolvePairedEvidenceRequest } from "../application/EvidenceInputResolver.js";
import { recordEvidenceSources } from "../application/investigation/recordEvidenceSources.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { WasmArtifactService } from "../application/wasm/WasmArtifactService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err } from "../domain/result.js";
import { wasmArtifactModule } from "../composition/wasm.js";
import type { Logger } from "pino";
import {
  createEvidenceToolHandler,
  createRetainedSummaryToolHandler,
} from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import {
  applicationToolRegistrationOptions,
  toolRegistrationOptions,
} from "./toolRegistrationOptions.js";

/** Bind the named WASM contract to shared validation and session Evidence recording. */
export const registerWasmTools = (
  server: EvidenceMcpServer,
  service: Pick<WasmArtifactService, "inspect">,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
  evidenceById?: EvidenceLookup,
): void => {
  const comparison = COMPARE_WASM_INTERFACES_CONTRACT;
  const compareHandler = createEvidenceToolHandler(
    server,
    async (rawInput, options) => {
      const input = comparison.inputSchema.safeParse(rawInput);
      if (!input.success)
        return err(
          analysisInputErrorFromIssues(
            comparison.name,
            input.error.issues,
            rawInput,
          ),
        );
      const sources = resolvePairedEvidenceRequest(input.data, evidenceById);
      if (!sources.ok) return sources;
      const result = await compareWasmInterfaces(sources.value, options);
      if (!result.ok) return result;
      const recorded = recordEvidenceSources(recordEvidence, [
        sources.value.left,
        sources.value.right,
      ]);
      return recorded.ok ? result : recorded;
    },
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    comparison.name,
    toolRegistrationOptions(comparison),
    compareHandler(comparison),
  );
  const contract = wasmArtifactModule.contract;
  const handler = createRetainedSummaryToolHandler(
    server,
    contract,
    (input, options) => service.inspect(input, options),
    logger,
    { recordEvidence, evidenceById },
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    applicationToolRegistrationOptions(contract),
    handler,
  );
};
