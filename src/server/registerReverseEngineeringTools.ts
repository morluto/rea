import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import {
  resolveRadare2CommandRequest,
  resolveRadiff2ComparisonRequest,
  resolveRizinCommandRequest,
  type ReverseEngineeringService,
} from "../application/reverse/ReverseEngineeringService.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { Evidence } from "../domain/evidence.js";
import { retainExternalMutationCancellation } from "./externalMutationAdmission.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";

/** Register objdump, Rizin, Radare2 and Radiff2 operations against their exact named contracts. */
export const registerReverseEngineeringTools = (
  server: McpServer,
  service: ReverseEngineeringService,
  logger: Logger,
  delivery: ToolResultDelivery,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
  invalidateSnapshotForExternalMutation?: () => void,
  withAdmittedExternalMutation?: <Value>(
    path: string | undefined,
    signal: AbortSignal | undefined,
    operation: () => Promise<Result<Value, AnalysisError>>,
    completionFailure: (
      value: Result<Value, AnalysisError>,
      error: AnalysisError,
    ) => AnalysisError,
    operationName: string,
  ) => Promise<Result<Result<Value, AnalysisError>, AnalysisError>>,
  evidenceById?: EvidenceLookup,
): void => {
  const objdump = toolContract("inspect_with_objdump");
  const rizin = toolContract("execute_rizin_command");
  const radare2 = toolContract("execute_radare2_command");
  const radiff2 = toolContract("compare_with_radiff2");
  server.registerTool(
    objdump.name,
    toolRegistrationOptions(objdump),
    (input, context: ServerContext) =>
      runAdmittedToolOperation(
        { delivery },
        withAdmittedAnalysis,
        objdump.name,
        context.mcpReq.signal,
        async () => {
          const result = await logToolExecution(logger, objdump.name, () =>
            service.inspectWithObjdump(
              input,
              {
                signal: context.mcpReq.signal,
              },
              { recordEvidence, evidenceById },
            ),
          );
          if (!result.ok)
            return delivery.toPartialErrorToolResult(
              result.error,
              objdump.returnsTargetContent,
              recordEvidence,
            );
          return delivery.toEvidenceToolResult(
            result.value,
            objdump,
            recordEvidence?.(result.value),
          );
        },
      ),
  );
  server.registerTool(
    rizin.name,
    toolRegistrationOptions(rizin),
    async (input, context: ServerContext) => {
      const parsed = resolveRizinCommandRequest(input);
      if (parsed.ok && withAdmittedExternalMutation !== undefined) {
        const cleanup = await service.retryCleanup(rizin.name);
        if (!cleanup.ok)
          return delivery.toPartialErrorToolResult(
            cleanup.error,
            rizin.returnsTargetContent,
            recordEvidence,
          );
        const admitted = await withAdmittedExternalMutation(
          parsed.value.path,
          context.mcpReq.signal,
          async () => {
            invalidateSnapshotForExternalMutation?.();
            return logToolExecution(logger, rizin.name, () =>
              service.executeRizinCommandValidated(parsed.value, {
                signal: context.mcpReq.signal,
              }),
            );
          },
          (value, cause) =>
            externalMutationRetirementFailure(
              rizin.name,
              "Rizin",
              value,
              cause,
            ),
          rizin.name,
        );
        if (!admitted.ok)
          return delivery.toPartialErrorToolResult(
            admitted.error,
            rizin.returnsTargetContent,
            recordEvidence,
          );
        const result = admitted.value;
        if (!result.ok)
          return delivery.toPartialErrorToolResult(
            result.error,
            rizin.returnsTargetContent,
            recordEvidence,
          );
        return delivery.toEvidenceToolResult(
          result.value,
          rizin,
          recordEvidence?.(result.value),
        );
      }
      return runAdmittedToolOperation(
        { delivery },
        withAdmittedAnalysis,
        rizin.name,
        context.mcpReq.signal,
        async () => {
          if (invalidateSnapshotForExternalMutation !== undefined && parsed.ok)
            invalidateSnapshotForExternalMutation();
          const result = await logToolExecution(logger, rizin.name, () =>
            parsed.ok
              ? service.executeRizinCommandValidated(parsed.value, {
                  signal: context.mcpReq.signal,
                })
              : Promise.resolve(parsed),
          );
          if (!result.ok)
            return delivery.toPartialErrorToolResult(
              result.error,
              rizin.returnsTargetContent,
              recordEvidence,
            );
          return delivery.toEvidenceToolResult(
            result.value,
            rizin,
            recordEvidence?.(result.value),
          );
        },
      );
    },
  );
  server.registerTool(
    radiff2.name,
    toolRegistrationOptions(radiff2),
    async (input, context: ServerContext) => {
      const parsed = resolveRadiff2ComparisonRequest(input);
      return runAdmittedToolOperation(
        { delivery },
        withAdmittedAnalysis,
        radiff2.name,
        context.mcpReq.signal,
        async () => {
          const result = await logToolExecution(logger, radiff2.name, () =>
            parsed.ok
              ? service.compareWithRadiff2Validated(parsed.value, {
                  signal: context.mcpReq.signal,
                })
              : Promise.resolve(parsed),
          );
          if (!result.ok)
            return delivery.toPartialErrorToolResult(
              result.error,
              radiff2.returnsTargetContent,
              recordEvidence,
            );
          return delivery.toEvidenceToolResult(
            result.value,
            radiff2,
            recordEvidence?.(result.value),
          );
        },
      );
    },
  );
  server.registerTool(
    radare2.name,
    toolRegistrationOptions(radare2),
    async (input, context: ServerContext) => {
      const parsed = resolveRadare2CommandRequest(input);
      if (parsed.ok && withAdmittedExternalMutation !== undefined) {
        const cleanup = await service.retryCleanup(radare2.name);
        if (!cleanup.ok)
          return delivery.toPartialErrorToolResult(
            cleanup.error,
            radare2.returnsTargetContent,
            recordEvidence,
          );
        const admitted = await withAdmittedExternalMutation(
          parsed.value.path,
          context.mcpReq.signal,
          async () => {
            invalidateSnapshotForExternalMutation?.();
            return logToolExecution(logger, radare2.name, () =>
              service.executeRadare2CommandValidated(parsed.value, {
                signal: context.mcpReq.signal,
              }),
            );
          },
          (value, cause) =>
            externalMutationRetirementFailure(
              radare2.name,
              "Radare2",
              value,
              cause,
            ),
          radare2.name,
        );
        if (!admitted.ok)
          return delivery.toPartialErrorToolResult(
            admitted.error,
            radare2.returnsTargetContent,
            recordEvidence,
          );
        const result = admitted.value;
        if (!result.ok)
          return delivery.toPartialErrorToolResult(
            result.error,
            radare2.returnsTargetContent,
            recordEvidence,
          );
        return delivery.toEvidenceToolResult(
          result.value,
          radare2,
          recordEvidence?.(result.value),
        );
      }
      return runAdmittedToolOperation(
        { delivery },
        withAdmittedAnalysis,
        radare2.name,
        context.mcpReq.signal,
        async () => {
          if (invalidateSnapshotForExternalMutation !== undefined && parsed.ok)
            invalidateSnapshotForExternalMutation();
          const result = await logToolExecution(logger, radare2.name, () =>
            parsed.ok
              ? service.executeRadare2CommandValidated(parsed.value, {
                  signal: context.mcpReq.signal,
                })
              : Promise.resolve(parsed),
          );
          if (!result.ok)
            return delivery.toPartialErrorToolResult(
              result.error,
              radare2.returnsTargetContent,
              recordEvidence,
            );
          return delivery.toEvidenceToolResult(
            result.value,
            radare2,
            recordEvidence?.(result.value),
          );
        },
      );
    },
  );
};

/**
 * Keep a retirement failure attached to one unrestricted external command:
 * a collected observation becomes the failing result's partial Evidence, and
 * an already-failed result retains the retirement error as a secondary cause.
 */
const externalMutationRetirementFailure = (
  operationName: string,
  providerName: string,
  value: Result<Evidence, AnalysisError>,
  cause: AnalysisError,
): AnalysisError => {
  if (cause instanceof AnalysisCancelledError)
    return retainExternalMutationCancellation(
      value,
      cause,
      (evidence) => evidence,
    );
  if (!value.ok)
    return value.error.retainSecondaryFailure(cause, {
      retirement_error: projectAnalysisError(cause),
    });
  return new AnalysisOutputError(
    operationName,
    `${providerName} may have changed the bound artifact, but the active analysis session could not be retired.`,
    {
      cause,
      ...(cause.capturedOutput === undefined
        ? {}
        : { capturedOutput: cause.capturedOutput }),
      partialObservation: value.value,
    },
  );
};
