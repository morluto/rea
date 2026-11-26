import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  closeArtifactResources,
  projectStableArtifactFailure,
  readStableArtifact,
  translateArtifactFailure,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  MAVEN_GRADLE_FILE_BYTES,
  mavenGradleFileBytesLimit,
  mavenGradleReportLimit,
  mavenGradleReportLimits,
  MAVEN_GRADLE_REPORT_LIMIT_BOUNDS,
  type MavenGradleReportLimitField,
  type InspectMavenGradleMetadataInput,
} from "../domain/java/mavenGradleMetadata.js";
import { err, ok } from "../domain/result.js";
import { MAVEN_GRADLE_METADATA_FORMAT } from "./MavenGradleMetadata.errors.js";
import { MAVEN_GRADLE_METADATA_PROVIDER_IDENTITY } from "./MavenGradleMetadataProviderIdentity.js";
import { parseMavenGradleMetadata } from "./MavenGradleMetadataParser.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";

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

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      MAVEN_GRADLE_METADATA_PROVIDER_IDENTITY,
      OPERATION,
    );
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
          parseMavenGradleMetadata(
            snapshot.bytes,
            {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            mavenGradleReportLimits(input.report_limits),
          ),
        );
      });
    } catch (cause) {
      return err(mavenGradleMetadataFailure(cause, input, snapshot));
    }
  }
}

const inputBudgetRemediation = (
  input: InspectMavenGradleMetadataInput,
): string =>
  input.max_file_bytes >= MAVEN_GRADLE_FILE_BYTES.maximum
    ? `The file exceeds the ${String(MAVEN_GRADLE_FILE_BYTES.maximum)}-byte input ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes, up to ${String(MAVEN_GRADLE_FILE_BYTES.maximum)}, or select a smaller artifact; this is the caller-selected input read budget.`;

const REPORT_LIMIT_FIELDS = Object.keys(
  MAVEN_GRADLE_REPORT_LIMIT_BOUNDS,
) as MavenGradleReportLimitField[];

const mavenGradleMetadataFailure = (
  cause: unknown,
  input: InspectMavenGradleMetadataInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  return projectStableArtifactFailure(
    cause,
    classifyProviderFailure(
      facts.cause,
      offlineArtifactFailureDialect(facts, {
        operation: OPERATION,
        providerId: MAVEN_GRADLE_METADATA_PROVIDER_IDENTITY.id,
        path: input.path,
        description: "Maven POM or Gradle module metadata",
        recognise: (failure) => {
          if (!isParseLimit(failure, MAVEN_GRADLE_METADATA_FORMAT))
            return undefined;
          const { name, maximum, required } = failure.failure.limit;
          const field = REPORT_LIMIT_FIELDS.find((field) => field === name);
          const limit =
            field === undefined
              ? undefined
              : mavenGradleReportLimit(field, maximum);
          return parseLimitConstraint(OPERATION, "memory", failure, {
            path: input.path,
            retryable: false,
            ...(limit === undefined
              ? {}
              : {
                  limit,
                  remediationAction:
                    maximum < limit.maximum &&
                    (required === undefined || required <= limit.maximum)
                      ? `Pass a larger ${limit.parameter}${required === undefined ? "" : ` (at least ${String(required)})`} on the next call for the same document; no restart is required.`
                      : `${limit.parameter} cannot exceed ${String(limit.maximum)}, which does not admit this document; select a document within that bound.`,
                }),
          });
        },
        fileSize: (failure) =>
          parseLimitConstraint(
            OPERATION,
            "file-size",
            decodeLimit(
              MAVEN_GRADLE_METADATA_FORMAT,
              failure.message,
              { name: "max_file_bytes", maximum: input.max_file_bytes },
              { cause: failure },
            ),
            {
              retryable: false,
              limit: mavenGradleFileBytesLimit(input.max_file_bytes),
              remediationAction: inputBudgetRemediation(input),
            },
          ),
        unclassified: (failure, origin) =>
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure
            ? translateArtifactFailure(OPERATION, input.path, failure)
            : new ArtifactOperationError(
                OPERATION,
                "io",
                undefined,
                errorMessage(failure),
                { cause: failure },
              ),
      }),
    ),
    input.path,
    MAVEN_GRADLE_METADATA_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};
