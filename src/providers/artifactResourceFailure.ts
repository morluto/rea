import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { stableArtifactInputRecovery } from "../artifacts/StableArtifactFailure.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  ArtifactAnalysisResources,
  type ArtifactResourceFailureContext,
} from "../process/ArtifactAnalysisResources.js";
import type { readLinuxResourceLimits } from "../process/LinuxResourceLimits.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "./classifyProviderFailure.js";

/**
 * The dialect for a failure the artifact resources observed: a selected input
 * read, a post-run identity read, or the resources' own descriptors. Each is
 * built from the typed pieces those resources own.
 */
export const artifactResourceDialect = (
  resources: ArtifactAnalysisResources,
  context: ArtifactResourceFailureContext,
): ProviderFailureDialect => {
  const { operation } = context;
  const { providerId } = resources;
  const observedOutput =
    context.kind === "selected-input"
      ? context.input.observedOutput
      : context.kind === "integrity"
        ? context.capturedOutput
        : undefined;
  const captured =
    observedOutput === undefined ? {} : { capturedOutput: observedOutput };
  const reasonOf = (cause: unknown) =>
    cause instanceof Error ? cause.message : String(cause);
  const shared = {
    providerId,
    operation,
    readCleanup: (
      read: Parameters<ArtifactAnalysisResources["readCleanupFailure"]>[0],
      primary: Parameters<ArtifactAnalysisResources["readCleanupFailure"]>[1],
    ) => resources.readCleanupFailure(read, primary, observedOutput, operation),
    observedOutput,
  };
  switch (context.kind) {
    case "selected-input": {
      const { input } = context;
      return {
        ...shared,
        file: {
          path: input.path,
          description: "artifact",
          fileSize: resources.selectedFileSize(input, operation),
          retainCompletedIdentity: true,
        },
        unclassified: (cause, details) =>
          new AnalysisInputError(
            operation,
            {
              ...details,
              cause,
              ...(cause instanceof ArtifactReaderFailure
                ? stableArtifactInputRecovery(cause)
                : {}),
            },
            [
              {
                path: ["path"],
                reason: "invalid_value",
                message: reasonOf(cause),
              },
            ],
          ),
      };
    }
    case "integrity":
      return {
        ...shared,
        recognise: (cause, details) =>
          cause instanceof ArtifactReaderFailure
            ? resources.integrityChanged(
                cause,
                context.path,
                { ...details, ...captured, cause },
                operation,
              )
            : undefined,
        unclassified: (cause, details) =>
          new ProviderAdapterError(providerId, operation, {
            ...details,
            ...captured,
            cause,
            diagnostics: {
              stage: "integrity",
              resource_path: context.path,
              reason: reasonOf(cause),
            },
          }),
      };
    case "resources":
      return {
        ...shared,
        unclassified: (cause, details) =>
          new ProviderAdapterError(providerId, operation, {
            ...details,
            cause,
            diagnostics: { stage: "artifact-resources", reason: String(cause) },
          }),
      };
  }
};

/** Artifact resources whose observed failures classify through the shared owner. */
export const createArtifactAnalysisResources = (
  providerId: string,
  operation: string,
  readArtifact: typeof readStableArtifact,
  readKernelLimits: typeof readLinuxResourceLimits,
  capacity: {
    readonly message: string;
    readonly details: Readonly<Record<string, JsonValue>>;
  },
): ArtifactAnalysisResources => {
  const resources: ArtifactAnalysisResources = new ArtifactAnalysisResources(
    providerId,
    operation,
    readArtifact,
    readKernelLimits,
    capacity,
    (cause, context) =>
      classifyProviderFailure(
        cause,
        artifactResourceDialect(resources, context),
      ),
  );
  return resources;
};
