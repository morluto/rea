import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { UefiOperation } from "../domain/uefi/uefiFirmwareAnalysis.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { classifyProviderOutcome } from "../process/classifyProviderOutcome.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { providerOutcomeOf } from "../process/ProviderOutcome.js";
import type { ProviderFailureDialect } from "../providers/classifyProviderFailure.js";
import {
  ArtifactReaderFailure,
  artifactFileCancellationCause,
} from "../resources/index.js";
import { UEFI_PROVIDER_IDENTITY } from "./UefiProviderIdentity.js";

/** Provider-specific reporting for a bounded decode and its stable artifact reads. */
export const uefiFailureDialect = (
  operation: UefiOperation,
  path: string,
): ProviderFailureDialect => {
  const providerId = UEFI_PROVIDER_IDENTITY.id;
  const cancellation = (
    reason: unknown,
    { cause: _cause, ...details }: AnalysisErrorOptions,
  ) =>
    reason instanceof AnalysisTimeoutError
      ? new AnalysisTimeoutError(operation, reason.timeoutMs, {
          ...details,
          cause: reason,
        })
      : cancelledBy(
          operation,
          carriedReason(
            reason instanceof AnalysisCancelledError ? reason.cause : reason,
          ),
          details,
        );
  return {
    providerId,
    operation,
    file: {
      path,
      description: "UEFI artifact",
      retainCompletedIdentity: true,
      fileSize: (cause, details) =>
        new AnalysisInputError(operation, { ...details, cause }, [
          { path: ["path"], reason: "out_of_range", message: cause.message },
        ]),
    },
    recognise(cause, details) {
      if (
        cause instanceof ArtifactReaderFailure &&
        cause.reason === "cancelled"
      ) {
        return cancellation(artifactFileCancellationCause(cause), {
          ...details,
          partialObservation: cause.partialObservation,
        });
      }
      if (
        cause instanceof DarwinProcessOwnershipInspectionError &&
        cause.cancellation !== undefined
      ) {
        return cancellation(cause.cancellation.reason, {
          ...details,
          capturedOutput: cause.capturedOutput,
        });
      }
      if (!(cause instanceof OwnedCommandFailure)) return undefined;
      const outcome = providerOutcomeOf(cause);
      const primary = classifyProviderOutcome(
        outcome.kind === "cancelled" &&
          outcome.reason instanceof AnalysisTimeoutError
          ? { ...outcome, kind: "timeout" }
          : outcome,
        {
          providerId,
          operation,
          details: {
            ...details,
            ...(cause.cleanupFailure === null
              ? {}
              : {
                  cleanup: {
                    reason: cause.cleanupFailure,
                    resources: cause.resources,
                  },
                }),
          },
          capturedOutput: capturedProviderOutput,
          timeout: { ms: UEFI_FIRMWARE_LIMITS.timeoutMs },
          outputLimit: {
            limits: { diagnostic_bytes: UEFI_FIRMWARE_LIMITS.diagnosticBytes },
            recovery: {
              retryable: false,
              remediationAction:
                "Use a smaller firmware image or select a narrower extraction scope.",
            },
          },
          dialect: (_outcome, _details, unclassified) => unclassified(),
        },
      );
      return primary;
    },
    unclassified: (cause, details) =>
      new ProviderAdapterError(providerId, operation, {
        ...details,
        cause,
        diagnostics: {
          phase: "unclassified",
          path,
          reason: errorMessage(cause),
        },
      }),
  };
};
