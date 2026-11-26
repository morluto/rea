import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { UefiOperation } from "../domain/uefi/uefiFirmwareAnalysis.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import {
  LzmaSession,
  type LzmaFailurePolicy,
} from "../providers/LzmaSession.js";
import {
  retainArtifactCommandCleanup,
  retainProcessInspectionCleanup,
} from "../providers/OwnedCommandCleanup.js";
import {
  AnalysisCleanupLeaseGroup,
  type ArtifactResourceScope,
} from "../resources/index.js";
import { uefiFailureDialect } from "./UefiFailures.js";
import { UEFI_PROVIDER_IDENTITY } from "./UefiProviderIdentity.js";

const failurePolicy = (
  operation: UefiOperation,
  resources: ArtifactResourceScope,
): LzmaFailurePolicy<AnalysisError> => ({
  runtimePrefix: "rea-uefi-lzma",
  isDeadlineAbort: (signal) => signal.reason instanceof AnalysisTimeoutError,
  classify: (cause, path) =>
    classifyProviderFailure(cause, uefiFailureDialect(operation, path)),
  retainInspectionCleanup(preparation, primary) {
    if (primary instanceof AnalysisTimeoutError) {
      if (
        preparation instanceof DarwinProcessOwnershipInspectionError &&
        preparation.capturedOutput !== undefined
      )
        primary.retainCapturedOutput(preparation.capturedOutput);
      for (const failure of retainArtifactCommandCleanup(
        preparation,
        resources,
        operation,
      ))
        primary = analysisErrorWithCleanupDependencies(
          primary,
          failure,
          operation,
        );
      return primary;
    }
    return retainProcessInspectionCleanup(
      preparation,
      primary,
      resources,
      operation,
    );
  },
  cleanupFailure(primary, released) {
    const failure = new ProviderCleanupError(
      UEFI_PROVIDER_IDENTITY.id,
      released.lease.cleanupResources ?? [released.owner.resource],
      { reason: errorMessage(released.cause) },
      { cause: released.cause, operation },
    );
    new AnalysisCleanupLeaseGroup(failure, [released.lease]);
    return primary === undefined
      ? failure
      : analysisErrorWithCleanupDependencies(primary, failure, operation);
  },
});

/** UEFI's caller-specific projection over the shared LZMA subprocess lane. */
export class UefiLzmaSession extends LzmaSession<AnalysisError> {
  constructor(
    workerModulePath: string,
    operation: UefiOperation,
    resources: ArtifactResourceScope,
  ) {
    super(workerModulePath, resources, failurePolicy(operation, resources));
  }
}
