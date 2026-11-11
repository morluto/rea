import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";

/** Adopt the inspector's retained helper and keep its original cleanup status live. */
export const retainProcessInspectionCleanup = (
  cause: unknown,
  primary: AnalysisError,
  resources: ArtifactResourceScope,
  operation: string,
): AnalysisError => {
  if (!(cause instanceof DarwinProcessOwnershipInspectionError)) return primary;
  if (cause.cleanupOwner !== undefined) {
    const owner = cause.cleanupOwner;
    resources.retain({
      kind: "lease",
      resource: "process ownership inspector",
      lease: { release: () => owner.close() },
    });
  }
  if (cause.cleanupFailure === undefined) return primary;
  return analysisErrorWithCleanupFailure(
    primary,
    cause.cleanupFailure,
    operation,
  ).bindCleanupDependencies([cause.cleanupFailure]);
};
