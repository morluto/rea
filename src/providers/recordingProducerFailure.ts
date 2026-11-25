import type {
  AnalysisCapturedOutput,
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { errorMessage } from "../kernel/errorMessage.js";
import type {
  ArtifactAnalysisResources,
  ArtifactAnalysisRuntime,
} from "../process/ArtifactAnalysisResources.js";
import { classifyProviderOutcome } from "../process/classifyProviderOutcome.js";
import type { LinuxResourceLimits } from "../process/LinuxResourceLimits.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { privateWorkspaceFailure } from "../process/privateWorkspaceFailure.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import { artifactResourceDialect } from "./artifactResourceFailure.js";
import { classifyProviderFailure } from "./classifyProviderFailure.js";

export type RecordingProducerPhase =
  | "configuration"
  | "workspace"
  | "producer"
  | "integrity";

interface RecordingProducerFailureContext {
  readonly phase: RecordingProducerPhase;
  readonly operation: string;
  readonly path: string;
  readonly root: ArtifactAnalysisRuntime | undefined;
  readonly limits: Parameters<ArtifactAnalysisResources["commandContext"]>[0];
  readonly effectiveLimits: LinuxResourceLimits | undefined;
  readonly observedOutput: AnalysisCapturedOutput | undefined;
  readonly catalog: {
    readonly format: string;
    readonly allowance: string;
    readonly unit: string;
  };
  readonly configurationHelp: string;
  readonly configurationDiagnostics?: (
    cause: unknown,
  ) => AnalysisErrorOptions["diagnostics"];
  readonly readerIntegrity: (
    failure: ArtifactReaderFailure,
    reason: string,
  ) => AnalysisError;
}

/** Classify a recording producer failure after retaining any unfinished command cleanup. */
export const classifyRecordingProducerFailure = (
  cause: unknown,
  resources: ArtifactAnalysisResources,
  context: RecordingProducerFailureContext,
): AnalysisError => {
  const { root, operation, phase, path, observedOutput, catalog } = context;
  if (
    root !== undefined &&
    cause instanceof OwnedCommandFailure &&
    cause.cleanupOwner !== undefined
  )
    resources.retain(root, cause.cleanupOwner);
  const workspacePath = root?.path ?? null;
  const command = resources.commandContext(
    context.limits,
    context.effectiveLimits,
    operation,
    "producer_limits",
  );
  if (phase === "integrity")
    return classifyProviderFailure(
      cause,
      artifactResourceDialect(resources, {
        kind: "integrity",
        operation,
        path,
        capturedOutput: observedOutput,
      }),
    );

  const captured =
    observedOutput === undefined ? {} : { capturedOutput: observedOutput };
  return classifyProviderFailure(cause, {
    providerId: resources.providerId,
    operation,
    recognise: (failure) =>
      isParseLimit(failure, catalog.format)
        ? parseLimitConstraint(operation, "memory", failure, {
            ...captured,
            ...fixedAllowanceOptions(catalog.allowance, "capture", {
              limit: failure.failure.limit.maximum,
              unit: catalog.unit,
            }),
          })
        : undefined,
    command: () => command,
    // The retained workspace reports unresolved cleanup when the run finishes.
    commandCleanup: (_failure, _primary, outcome) =>
      classifyProviderOutcome(outcome, command),
    readCleanup: (read, primary) =>
      resources.readCleanupFailure(read, primary, observedOutput, operation),
    observedOutput,
    unclassified: (failure) => {
      const reason = errorMessage(failure);
      if (phase === "workspace")
        return privateWorkspaceFailure(
          resources.providerId,
          operation,
          failure,
          workspacePath,
        );
      if (phase === "configuration") {
        const diagnostics = context.configurationDiagnostics?.(failure);
        return new AnalysisCapabilityUnavailableError(
          resources.providerId,
          operation,
          reason,
          {
            cause: failure,
            ...captured,
            ...(diagnostics === undefined ? {} : { diagnostics }),
            userMessage: `${reason} ${context.configurationHelp}`,
          },
        );
      }
      if (
        failure instanceof ArtifactReaderFailure &&
        failure.reason === "integrity"
      )
        return context.readerIntegrity(failure, reason);
      return new AnalysisOutputError(operation, reason, {
        cause: failure,
        ...captured,
      });
    },
  });
};
