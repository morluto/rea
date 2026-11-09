import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { bindArtifactFileCleanup } from "./ArtifactFileOperation.js";
import { completedStableArtifactObservation } from "./StableArtifactObservation.js";
import type { StableArtifactSnapshot } from "./readStableArtifact.js";

/** Name an observed regular-file retry that admission will validate again. */
export const regularFileSymlinkRecovery = (resolvedPath: string): string =>
  `Retry with the resolved regular file path ${resolvedPath}. The selected symlink is not admitted; the retry will validate the target again.`;

/** Offer the verified regular-file target after a selected symlink is rejected. */
export const stableArtifactInputRecovery = (cause: ArtifactReaderFailure) =>
  cause.reason === "path" && cause.resolvedPath !== undefined
    ? {
        remediationAction: regularFileSymlinkRecovery(cause.resolvedPath),
        conformsToInputContract: true,
      }
    : {};

const artifactCleanupFailure = (
  cause: unknown,
  providerId: string,
  operation: string,
): ProviderCleanupError | undefined => {
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return undefined;
  return new ProviderCleanupError(
    providerId,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { cause, operation },
  );
};

/** Project descriptor cleanup while keeping its exact leases bound to the error. */
export const projectArtifactCloseFailure = (
  cause: unknown,
  providerId: string,
  operation: string,
): unknown => {
  const error = artifactCleanupFailure(cause, providerId, operation);
  if (error === undefined) return cause;
  bindArtifactFileCleanup(cause, error);
  return error;
};

/** Preserve completed physical identity, including a snapshot whose decoding failed, and exact cleanup ownership around a provider's primary failure. */
export const projectStableArtifactFailure = (
  cause: unknown,
  primary: AnalysisError,
  path: string,
  providerId: string,
  operation: string,
  snapshot?: StableArtifactSnapshot,
): AnalysisError => {
  const observation = completedStableArtifactObservation(cause, path, snapshot);
  if (observation !== undefined) primary.retainPartialObservation(observation);
  const cleanup = artifactCleanupFailure(cause, providerId, operation);
  if (cleanup === undefined) return primary;
  const error = analysisErrorWithCleanupFailure(primary, cleanup, operation);
  bindArtifactFileCleanup(cause, error);
  return error;
};
