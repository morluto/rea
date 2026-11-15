import { RPM_PACKAGE_PROVIDER_IDENTITY } from "./RpmPackageProviderIdentity.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  completedStableArtifactObservation,
  projectArtifactCloseFailure,
  readStableArtifact,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import type { RpmPackagePort } from "../ports/rpm/RpmPackagePort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { parseFailureAnalysisError } from "../domain/parseFailureAnalysisError.js";
import {
  MAX_INSPECT_RPM_PACKAGE_FILE_BYTES,
  MAX_INSPECT_RPM_PACKAGE_FILES,
  MAX_INSPECT_RPM_PACKAGE_HEADER_INDEX_ENTRIES,
  MAX_INSPECT_RPM_PACKAGE_SCRIPT_BYTES,
  type InspectRpmPackageInput,
} from "../domain/rpm/package.js";
import { err, ok } from "../domain/result.js";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import { RpmPackageCapacityFailure } from "./RpmPackage.errors.js";
import { parseRpmPackage } from "./RpmPackageParser.js";

const OPERATION = "inspect_rpm_package";

const inputBudgetRemediation = (
  cause: ArtifactReaderFailure,
  input: InspectRpmPackageInput,
): string | undefined => {
  if (cause.boundary === "file-size")
    return input.max_file_bytes >= MAX_INSPECT_RPM_PACKAGE_FILE_BYTES
      ? `The file exceeds the ${String(MAX_INSPECT_RPM_PACKAGE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;
  if (!(cause instanceof RpmPackageCapacityFailure)) return undefined;
  switch (cause.resource) {
    case "max_header_index_entries":
      return cause.maximum >= MAX_INSPECT_RPM_PACKAGE_HEADER_INDEX_ENTRIES
        ? `The header exceeds the ${String(MAX_INSPECT_RPM_PACKAGE_HEADER_INDEX_ENTRIES)}-entry ceiling this operation accepts; select a smaller artifact.`
        : `Raise max_header_index_entries above ${String(cause.maximum)} or select a smaller artifact; the limit is the caller-selected header index budget.`;
    case "max_files":
      return cause.maximum >= MAX_INSPECT_RPM_PACKAGE_FILES
        ? `The file inventory exceeds the ${String(MAX_INSPECT_RPM_PACKAGE_FILES)}-file ceiling this operation accepts; select a smaller artifact.`
        : `Raise max_files above ${String(cause.maximum)} or select a smaller artifact; the limit is the caller-selected file-inventory budget.`;
    case "max_script_bytes":
      return cause.maximum >= MAX_INSPECT_RPM_PACKAGE_SCRIPT_BYTES
        ? `The scriptlet exceeds the ${String(MAX_INSPECT_RPM_PACKAGE_SCRIPT_BYTES)}-byte ceiling this operation accepts; select a smaller artifact.`
        : `Raise max_script_bytes above ${String(cause.maximum)} or select a smaller artifact; the limit is the caller-selected script text budget.`;
    case "max_file_bytes":
      return input.max_file_bytes >= MAX_INSPECT_RPM_PACKAGE_FILE_BYTES
        ? `The file exceeds the ${String(MAX_INSPECT_RPM_PACKAGE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
        : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;
  }
};

const budgetFailure = (
  cause: ArtifactReaderFailure,
  input: InspectRpmPackageInput,
  details: AnalysisErrorOptions,
) => {
  const remediationAction = inputBudgetRemediation(cause, input);
  return new AnalysisResourceConstraintError(
    OPERATION,
    cause.boundary ?? "memory",
    cause.message,
    {
      max_file_bytes: input.max_file_bytes,
      max_header_index_entries: input.max_header_index_entries,
      max_files: input.max_files,
      max_script_bytes: input.max_script_bytes,
    },
    {
      ...details,
      cause,
      ...(remediationAction === undefined
        ? {}
        : { retryable: false, remediationAction }),
    },
  );
};

/**
 * RPM's dialect for the shared provider failure classifier. Parser format
 * refusals and the budget refusals with their recovery advice are the only
 * cases this provider names.
 */
const failureDialect = (
  input: InspectRpmPackageInput,
): ProviderFailureDialect => ({
  providerId: RPM_PACKAGE_PROVIDER_IDENTITY.id,
  operation: OPERATION,
  recognise: (cause, details) => {
    if (cause instanceof RpmPackageCapacityFailure)
      return budgetFailure(cause, input, details);
    return parseFailureAnalysisError(OPERATION, input.path, cause);
  },
  file: {
    path: input.path,
    description: "RPM package",
    retainCompletedIdentity: true,
    fileSize: (limit, details) => budgetFailure(limit, input, details),
  },
  unclassified: (cause, details) =>
    new ArtifactOperationError(
      OPERATION,
      "io",
      undefined,
      cause instanceof Error ? cause.message : "RPM package inspection failed.",
      { ...details, cause },
    ),
});

/** Portable parser over one bounded, identity-checked regular file. */
export class RpmPackageProvider implements RpmPackagePort {
  readonly identity = RPM_PACKAGE_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        RPM_PACKAGE_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectRpmPackageInput, options?: ExecutionOptions) {
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        return ok(
          parseRpmPackage(
            snapshot.bytes,
            {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            input,
            options?.signal,
          ),
        );
      });
    } catch (cause) {
      const failure = classifyProviderFailure(cause, failureDialect(input));
      // The read already completed; its byte identity stays on the parser refusal.
      if (snapshot !== undefined) {
        const observation = completedStableArtifactObservation(
          cause,
          input.path,
          snapshot,
        );
        if (observation !== undefined)
          failure.retainPartialObservation(observation);
      }
      return err(failure);
    }
  }
}
