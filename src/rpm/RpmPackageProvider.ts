import { RPM_PACKAGE_PROVIDER_IDENTITY } from "./RpmPackageProviderIdentity.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  projectArtifactCloseFailure,
  projectOwnedArtifactIdentityFailure,
  projectOwnedArtifactInputFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  translateArtifactFailure,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import type { RpmPackagePort } from "../ports/rpm/RpmPackagePort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { decodeLimit } from "../domain/parseFailure.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_RPM_PACKAGE_FILE_BYTES,
  MAX_INSPECT_RPM_PACKAGE_FILES,
  MAX_INSPECT_RPM_PACKAGE_HEADER_INDEX_ENTRIES,
  MAX_INSPECT_RPM_PACKAGE_SCRIPT_BYTES,
  type InspectRpmPackageInput,
} from "../domain/rpm/package.js";
import { err, ok } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { parseRpmPackage } from "./RpmPackageParser.js";

const OPERATION = "inspect_rpm_package";

const inputBudgetRemediation = (input: InspectRpmPackageInput): string =>
  input.max_file_bytes >= MAX_INSPECT_RPM_PACKAGE_FILE_BYTES
    ? `The file exceeds the ${String(MAX_INSPECT_RPM_PACKAGE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const parserBudgetRecovery = (name: string, maximum: number) => {
  const budget =
    name === "max_header_index_entries"
      ? {
          field: name,
          ceiling: MAX_INSPECT_RPM_PACKAGE_HEADER_INDEX_ENTRIES,
          subject: "header index",
          unit: "entries",
        }
      : name === "max_files"
        ? {
            field: name,
            ceiling: MAX_INSPECT_RPM_PACKAGE_FILES,
            subject: "file inventory",
            unit: "rows",
          }
        : name === "max_script_bytes"
          ? {
              field: name,
              ceiling: MAX_INSPECT_RPM_PACKAGE_SCRIPT_BYTES,
              subject: "scriptlet text",
              unit: "bytes",
            }
          : {
              field: "max_file_bytes",
              ceiling: MAX_INSPECT_RPM_PACKAGE_FILE_BYTES,
              subject: "expanded file paths",
              unit: "bytes",
            };
  return maximum >= budget.ceiling
    ? fixedAllowanceOptions(`The RPM ${budget.subject} ceiling`, "parser", {
        limit: budget.ceiling,
        unit: budget.unit,
      })
    : {
        retryable: false as const,
        remediationAction: `Raise ${budget.field} above ${String(maximum)}, up to ${String(budget.ceiling)}, or select a smaller artifact; this is the caller-selected ${budget.subject} budget.`,
      };
};

const rpmPackageFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectRpmPackageInput,
) => {
  const { cause, origin } = facts;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (isParseLimit(cause, "rpm")) {
    const { name, maximum } = cause.failure.limit;
    return parseLimitConstraint(OPERATION, "memory", cause, {
      path: input.path,
      ...parserBudgetRecovery(name, maximum),
    });
  }
  const formatFailure = parseFailureAnalysisError(OPERATION, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
  const inputFailure = projectOwnedArtifactInputFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (inputFailure !== undefined) return inputFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit" && cause.boundary === "file-size")
      return parseLimitConstraint(
        OPERATION,
        "file-size",
        decodeLimit(
          "rpm",
          cause.message,
          { name: "max_file_bytes", maximum: input.max_file_bytes },
          { cause },
        ),
        {
          retryable: false,
          remediationAction: inputBudgetRemediation(input),
        },
      );
    return translateArtifactFailure(OPERATION, cause);
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
    "io",
    undefined,
    errorMessage(cause),
    { cause },
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
      return err(
        projectStableArtifactFailure(
          cause,
          rpmPackageFailurePrimary(artifactFilePrimaryFacts(cause), input),
          input.path,
          RPM_PACKAGE_PROVIDER_IDENTITY.id,
          OPERATION,
          snapshot,
        ),
      );
    }
  }
}
