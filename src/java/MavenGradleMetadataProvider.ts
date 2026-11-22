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
  projectOwnedArtifactInputFailure,
  translateArtifactFailure,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import {
  isParseLimit,
  parseLimitConstraint,
  parseFailureAnalysisError,
} from "../domain/parseFailureAnalysisError.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES,
  type InspectMavenGradleMetadataInput,
} from "../domain/java/mavenGradleMetadata.js";
import { err, ok } from "../domain/result.js";
import {
  MAVEN_GRADLE_METADATA_FORMAT,
  type MavenGradleReportAllowance,
} from "./MavenGradleMetadata.errors.js";
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
  input: InspectMavenGradleMetadataInput,
): string =>
  input.max_file_bytes >= MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES
    ? `The file exceeds the ${String(MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes, up to ${String(MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES)}, or select a smaller artifact; this is the caller-selected input read budget.`;

/** The subject a fixed-allowance remediation names for each report allowance. */
const REPORT_ALLOWANCE_SUBJECTS: Readonly<
  Record<MavenGradleReportAllowance, (limit: number) => string>
> = {
  dependency_rows: (limit) =>
    `The ${String(limit)}-row allowance for dependency and constraint rows`,
  variants: (limit) =>
    `The ${String(limit)}-variant allowance for Gradle module variants`,
  exclusions: (limit) =>
    `The ${String(limit)}-exclusion allowance for dependency exclusions`,
  unresolved_records: (limit) =>
    `The ${String(limit)}-record allowance for unresolved references and coordinates`,
  xml_nodes: (limit) =>
    `The ${String(limit)}-node allowance for a Maven POM document tree`,
  repeated_variant_name_chars: (limit) =>
    `The ${String(limit)}-character allowance for variant names repeated across Gradle dependency rows`,
};

const mavenGradleMetadataFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectMavenGradleMetadataInput,
) => {
  const { cause, origin } = facts;
  if (isParseLimit(cause, MAVEN_GRADLE_METADATA_FORMAT)) {
    const { name, maximum } = cause.failure.limit;
    return parseLimitConstraint(OPERATION, "memory", cause, {
      path: input.path,
      ...fixedAllowanceOptions(
        Object.entries(REPORT_ALLOWANCE_SUBJECTS).find(
          ([key]) => key === name,
        )?.[1](maximum) ?? name,
        name === "xml_nodes" ? "parser" : "report",
        {
          limit: maximum,
          unit:
            name === "repeated_variant_name_chars"
              ? "UTF-16 code units"
              : name === "unresolved_records"
                ? "records"
                : name === "dependency_rows"
                  ? "rows"
                  : name === "xml_nodes"
                    ? "nodes"
                    : name,
        },
      ),
    });
  }
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
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
          MAVEN_GRADLE_METADATA_FORMAT,
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
    "Maven POM or Gradle module metadata",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    errorMessage(cause),
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
