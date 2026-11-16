import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  projectArtifactCloseFailure,
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  stableArtifactInputFailure,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import { parseFailureAnalysisError } from "../domain/parseFailureAnalysisError.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES,
  type InspectMavenGradleMetadataInput,
} from "../domain/java/mavenGradleMetadata.js";
import { err, ok } from "../domain/result.js";
import { MavenGradleMetadataReportFailure } from "./MavenGradleMetadata.errors.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { MAVEN_GRADLE_METADATA_PROVIDER_IDENTITY } from "./MavenGradleMetadataProviderIdentity.js";
import { parseMavenGradleMetadata } from "./MavenGradleMetadataParser.js";

const OPERATION = "inspect_maven_gradle_metadata";

/** Portable parser over one bounded, identity-checked POM or module-metadata file. */
/**
 * Satisfies the application's MavenGradleMetadataPort structurally;
 * composition checks the fit, so this provider does not import the
 * application layer.
 */
export class MavenGradleMetadataProvider {
  readonly identity = MAVEN_GRADLE_METADATA_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        MAVEN_GRADLE_METADATA_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectMavenGradleMetadataInput,
    options?: { readonly signal?: AbortSignal },
  ) {
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
          parseMavenGradleMetadata(snapshot.bytes, {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          }),
        );
      });
    } catch (cause) {
      return err(mavenGradleMetadataFailure(cause, input, snapshot));
    }
  }
}

const inputBudgetRemediation = (
  cause: ArtifactReaderFailure,
  input: InspectMavenGradleMetadataInput,
): string | undefined => {
  if (cause.boundary === "file-size")
    return input.max_file_bytes >= MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES
      ? `The file exceeds the ${String(MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;
  return undefined;
};

const mavenGradleMetadataFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectMavenGradleMetadataInput,
) => {
  const { cause, origin } = facts;
  if (cause instanceof MavenGradleMetadataReportFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      { [cause.allowance]: cause.limit },
      {
        cause,
        ...fixedAllowanceOptions(
          cause.allowance === "dependency_rows"
            ? `The ${String(cause.limit)}-row allowance for dependency and constraint rows`
            : `The ${String(cause.limit)}-character allowance for variant names repeated across Gradle dependency rows`,
          "report",
        ),
      },
    );
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  const formatFailure = parseFailureAnalysisError(OPERATION, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
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
        { max_file_bytes: input.max_file_bytes },
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
    "Maven POM or Gradle module metadata",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : "Maven POM or Gradle module metadata inspection failed.",
    { cause },
  );
};

const mavenGradleMetadataFailure = (
  cause: unknown,
  input: InspectMavenGradleMetadataInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const primary = mavenGradleMetadataFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    MAVEN_GRADLE_METADATA_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};
