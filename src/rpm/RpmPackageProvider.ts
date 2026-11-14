import { RPM_PACKAGE_PROVIDER_IDENTITY } from "./RpmPackageProviderIdentity.js";
import {
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
  stableArtifactInputFailure,
} from "../artifacts/StableArtifactFailure.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  type StableArtifactSnapshot,
  readStableArtifact,
} from "../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { RpmPackagePort } from "../application/rpm/RpmPackagePort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
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

const rpmFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectRpmPackageInput,
) => {
  const { cause, origin } = facts;
  const formatFailure = parseFailureAnalysisError(OPERATION, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit") {
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
          cause,
          ...(remediationAction === undefined
            ? {}
            : { retryable: false, remediationAction }),
        },
      );
    }
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "RPM package",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error ? cause.message : "RPM package inspection failed.",
    { cause },
  );
};

const rpmFailure = (
  cause: unknown,
  input: InspectRpmPackageInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const primary = rpmFailurePrimary(artifactFilePrimaryFacts(cause), input);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    RPM_PACKAGE_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};

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
      return err(rpmFailure(cause, input, snapshot));
    }
  }
}
