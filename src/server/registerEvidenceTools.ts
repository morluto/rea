import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";

import type {
  AnalysisOperation,
  AnalysisOperationPort,
} from "../application/AnalysisProvider.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import type { Logger } from "pino";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { createArtifactExtractionDestination } from "../application/artifacts/ArtifactExtractionDestination.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

interface EvidenceToolRegistration {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly withAdmittedAnalysis: WithAdmittedAnalysis;
  readonly analysisForAdmission?: (
    analysis: AnalysisOperationPort,
  ) => AnalysisOperationPort;
  readonly sourceEvidence?: (
    operation: Exclude<AnalysisOperation, "health">,
    result: import("../domain/jsonValue.js").JsonValue,
  ) => readonly Evidence[];
}

/** Register provider-backed contracts that return atomic Evidence observations. */
export const registerEvidenceTools = (
  server: EvidenceMcpServer,
  contracts: readonly ToolContract<Exclude<AnalysisOperation, "health">>[],
  options: EvidenceToolRegistration,
): void => {
  for (const contract of contracts) {
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async (input, context) => {
        const admitted = await options.withAdmittedAnalysis(
          contract.name,
          context.mcpReq.signal,
          async (admittedAnalysis) => {
            const analysis =
              options.analysisForAdmission?.(admittedAnalysis) ??
              admittedAnalysis;
            const progress = mcpProgressReporter(context);
            await progress.report({
              phase: contract.name,
              completed: 0,
              total: 1,
              message: "started",
            });
            const parameters = jsonObjectSchema.parse(input);
            const executionParameters =
              contract.name === "extract_artifact"
                ? {
                    ...parameters,
                    output_root: createArtifactExtractionDestination(),
                  }
                : parameters;
            const execution = await logToolExecution(
              options.logger,
              contract.name,
              () =>
                analysis.execute(contract.name, executionParameters, {
                  signal: context.mcpReq.signal,
                  progress,
                }),
            );
            await progress.report({
              phase: contract.name,
              completed: 1,
              total: 1,
              message: execution.ok ? "completed" : "failed",
              terminal: true,
            });
            if (!execution.ok)
              return server.delivery.toCallToolResult(execution, contract);
            const sourceEvidence =
              options.sourceEvidence?.(contract.name, execution.value.result) ??
              [];
            const evidence = createEvidence(
              execution.value.subject ?? options.activeTarget?.(),
              execution.value.provider,
              {
                operation: contract.name,
                parameters,
                result: execution.value.result,
                ...(execution.value.analysisProfile === undefined
                  ? {}
                  : { analysisProfile: execution.value.analysisProfile }),
                rawResult: execution.value.rawResult,
                limitations: execution.value.limitations,
                locations: execution.value.locations,
                evidenceLinks: sourceEvidence.map(({ evidence_id: id }) => id),
              },
            );
            for (const source of sourceEvidence) {
              const sourceRecorded = options.recordEvidence?.(source);
              if (sourceRecorded !== undefined && !sourceRecorded.ok)
                return server.delivery.toCallToolResult(
                  sourceRecorded,
                  contract,
                );
            }
            const recorded = options.recordEvidence?.(evidence);
            return server.delivery.toEvidenceToolResult(
              evidence,
              contract,
              recorded,
            );
          },
        );
        return admitted.ok
          ? admitted.value
          : server.delivery.toCallToolResult(admitted, contract);
      },
    );
  }
};
