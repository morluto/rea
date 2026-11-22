import type {
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import { completedOperationEvidence } from "../application/binary/SessionEvidenceReuse.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  retainedSummaryDelivery,
  withoutDeliveryDetail,
} from "./retainedSummaryDelivery.js";
import type {
  AnalysisOperation,
  AnalysisOperationPort,
} from "../ports/AnalysisProvider.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import { ok } from "../domain/result.js";
import type { RecoveryAdmission } from "../application/investigation/InvestigationRetention.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ownedJsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { mcpProgressReporter } from "./mcpProgress.js";
import { logToolExecution } from "./toolLogging.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { recordEvidenceSources } from "../application/investigation/recordEvidenceSources.js";
import { createOperationProgress } from "./operationProgress.js";
import { withEvidenceProviderSelection } from "../domain/evidence.js";

import { currentMcpToolRequest } from "./McpToolRequest.js";

/** A provider operation a tool contract names. */
export type ProviderOperation = Exclude<AnalysisOperation, "health">;

/**
 * How one family's provider operations run: the target their observations
 * are about when the provider names none, the recovery admission a completed
 * analysis passes, and the family's own routing of the admitted analysis and
 * of execution parameters.
 */
export interface ProviderOperationOptions {
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly admitRecovery?: RecoveryAdmission | undefined;
  readonly analysisForAdmission?:
    | ((analysis: AnalysisOperationPort) => AnalysisOperationPort)
    | undefined;
  readonly parametersForExecution?:
    | ((
        operation: ProviderOperation,
        parameters: Readonly<Record<string, JsonValue>>,
      ) => Readonly<Record<string, JsonValue>>)
    | undefined;
}

/** The shared logging, recording and admission a provider operation runs under. */
export interface ProviderOperationDependencies {
  readonly logger: Logger;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
  readonly evidenceById: EvidenceLookup | undefined;
  readonly withAdmittedAnalysis: WithAdmittedAnalysis;
}

/**
 * Run one provider operation on the analysis admission grants and deliver its
 * observation as atomic Evidence: the session's reusable record when it
 * already holds the same observation, else a new record admitted against the
 * completed analysis. A `detail: "summary"` request is refused before analysis
 * when nothing retains the complete Evidence, and never reaches the provider
 * of a contract that declares a retained summary.
 */
export const createProviderOperationToolHandler =
  (
    server: EvidenceMcpServer,
    operation: ProviderOperation,
    options: ProviderOperationOptions,
    dependencies: ProviderOperationDependencies,
  ) =>
  (contract: ToolContract) => {
    const delivery =
      contract.retainedSummary === undefined
        ? undefined
        : retainedSummaryDelivery(contract.name, dependencies);
    return async (
      input: unknown,
      context: ServerContext,
    ): Promise<CallToolResult> => {
      const resolved = ownedJsonObjectSchema.parse(input);
      const parameters =
        currentMcpToolRequest()?.callerParameters(
          contract.name,
          input,
          resolved,
        ) ?? resolved;
      const ready = delivery?.preflight(resolved) ?? ok(null);
      if (!ready.ok) return server.delivery.toCallToolResult(ready, contract);
      const admitted = await dependencies.withAdmittedAnalysis(
        contract.name,
        context.mcpReq.signal,
        async (admittedAnalysis) => {
          const analysis =
            options.analysisForAdmission?.(admittedAnalysis) ??
            admittedAnalysis;
          const progress = createOperationProgress(
            mcpProgressReporter(context),
            contract.name,
          );
          await progress.start();
          const providerParameters =
            contract.retainedSummary === undefined
              ? parameters
              : withoutDeliveryDetail(parameters);
          const executionParameters =
            options.parametersForExecution?.(operation, providerParameters) ??
            providerParameters;
          const execution = await logToolExecution(
            dependencies.logger,
            contract.name,
            () =>
              analysis.execute(operation, executionParameters, {
                signal: context.mcpReq.signal,
                progress,
                isOperationAdvertised: (advertised) =>
                  server.advertisesTool(advertised),
              }),
          );
          if (!execution.ok)
            return progress.complete(
              server.delivery.toCallToolResult(execution, contract),
            );
          const sourceEvidence = execution.value.sourceEvidence ?? [];
          const sourceRecorded = recordEvidenceSources(
            dependencies.recordEvidence,
            sourceEvidence,
          );
          if (!sourceRecorded.ok)
            return progress.complete(
              server.delivery.toCallToolResult(sourceRecorded, contract),
            );
          const evidenceParameters =
            contract.retainedSummary?.evidenceParameters === "omit-detail"
              ? providerParameters
              : parameters;
          const evidence = completedOperationEvidence(
            operation,
            evidenceParameters,
            execution.value,
            {
              target: options.activeTarget?.() ?? null,
              admitRecovery: options.admitRecovery,
              evidenceById: dependencies.evidenceById,
            },
          );
          if (!evidence.ok)
            return progress.complete(
              server.delivery.toCallToolResult(evidence, contract),
            );
          const projected =
            delivery?.projectEvidence(resolved, evidence.value) ??
            ok(evidence.value);
          if (!projected.ok)
            return progress.complete(
              server.delivery.toCallToolResult(projected, contract),
            );
          // Recording stamps the session's provider selection onto the
          // retained record under this evidence_id, so the copy delivered now
          // must carry the same stamp or the response and the retained view
          // disagree for one id.
          const recorded = dependencies.recordEvidence?.(projected.value);
          const retained = dependencies.evidenceById?.(
            projected.value.evidence_id,
          );
          const delivered =
            retained?.provider_selection === undefined
              ? projected.value
              : withEvidenceProviderSelection(
                  projected.value,
                  retained.provider_selection,
                );
          return progress.complete(
            server.delivery.toEvidenceToolResult(delivered, contract, recorded),
          );
        },
      );
      return admitted.ok
        ? admitted.value
        : server.delivery.toCallToolResult(admitted, contract);
    };
  };
