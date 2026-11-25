import type {
  AnalysisCapturedOutput,
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { errorMessage } from "../kernel/errorMessage.js";
import type { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import { classifyProviderOutcome } from "../process/classifyProviderOutcome.js";
import type { LinuxResourceLimits } from "../process/LinuxResourceLimits.js";
import { privateWorkspaceFailure } from "../process/privateWorkspaceFailure.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import { artifactResourceDialect } from "./artifactResourceFailure.js";
import type { ProviderFailureDialect } from "./classifyProviderFailure.js";

export type RecordingProducerPhase =
  | "configuration"
  | "workspace"
  | "producer"
  | "integrity";

interface RecordingProducerFailureContext {
  readonly phase: RecordingProducerPhase;
  readonly operation: string;
  readonly path: string;
  readonly workspacePath: string | null;
  readonly limits: Parameters<ArtifactAnalysisResources["commandContext"]>[0];
  readonly effectiveLimits: LinuxResourceLimits | undefined;
  readonly observedOutput: AnalysisCapturedOutput | undefined;
  readonly catalog: {
    readonly format: string;
    readonly allowance: (
      maximum: number,
    ) => ReturnType<typeof fixedAllowanceOptions>;
  };
  readonly configurationHelp: string;
  readonly configurationDiagnostics?: (
    cause: unknown,
  ) => AnalysisErrorOptions["diagnostics"];
  /** A reader integrity failure, classified by its owner. */
  readonly readerIntegrity: (failure: ArtifactReaderFailure) => AnalysisError;
}

/** Describe recording failures in terms of the command, workspace, and catalog that produced them. */
export const recordingProducerFailureDialect = (
  resources: ArtifactAnalysisResources,
  context: RecordingProducerFailureContext,
): ProviderFailureDialect => {
  const { workspacePath, operation, phase, path, observedOutput, catalog } =
    context;
  const command = resources.commandContext(
    context.limits,
    context.effectiveLimits,
    operation,
  );
  if (phase === "integrity")
    return artifactResourceDialect(resources, {
      kind: "integrity",
      operation,
      path,
      capturedOutput: observedOutput,
    });

  const captured =
    observedOutput === undefined ? {} : { capturedOutput: observedOutput };
  return {
    providerId: resources.providerId,
    operation,
    recognise: (failure) =>
      isParseLimit(failure, catalog.format)
        ? parseLimitConstraint(operation, "memory", failure, {
            ...captured,
            ...catalog.allowance(failure.failure.limit.maximum),
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
        return context.readerIntegrity(failure);
      return new AnalysisOutputError(operation, reason, {
        cause: failure,
        ...captured,
      });
    },
  };
};
