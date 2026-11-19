import { VSIX_PACKAGE_PROVIDER_IDENTITY } from "./VsixPackageProviderIdentity.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  projectArtifactCloseFailure,
  projectOwnedArtifactIdentityFailure,
  projectOwnedArtifactInputFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  translateArtifactFailure,
  type ArtifactFilePrimaryFacts,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { fixedCeilingConstraint } from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import {
  VSIX_PACKAGE_FORMAT,
  VSIX_PACKAGE_LIMIT_MAXIMA,
  type InspectVsixPackageInput,
} from "../domain/vsix/vsixPackage.js";
import { err, ok } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { parseVsixPackage } from "./VsixPackageParser.js";

const OPERATION = "inspect_vsix_package";

const budgetRecovery = (
  parameter: keyof typeof VSIX_PACKAGE_LIMIT_MAXIMA,
  selected: number,
): string =>
  selected >= VSIX_PACKAGE_LIMIT_MAXIMA[parameter]
    ? `${parameter} is at this operation's maximum of ${String(VSIX_PACKAGE_LIMIT_MAXIMA[parameter])}; select a complete artifact within that bound.`
    : `Raise ${parameter} above ${String(selected)}, up to ${String(VSIX_PACKAGE_LIMIT_MAXIMA[parameter])}, or select a smaller artifact. The budget applies on the next call; repeating the unchanged request does not raise it.`;

const vsixFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectVsixPackageInput,
) => {
  const { cause, origin } = facts;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (isParseLimit(cause, VSIX_PACKAGE_FORMAT)) {
    if (cause.failure.limit.name === "xml_nodes")
      return parseLimitConstraint(OPERATION, "memory", cause, {
        path: input.path,
        ...fixedAllowanceOptions(
          `The ${String(cause.failure.limit.maximum)}-node allowance for an extension.vsixmanifest document tree`,
          "parser",
          { limit: cause.failure.limit.maximum, unit: "nodes" },
        ),
      });
    const parameter = (
      Object.keys(
        VSIX_PACKAGE_LIMIT_MAXIMA,
      ) as (keyof typeof VSIX_PACKAGE_LIMIT_MAXIMA)[]
    ).find((name) => name === cause.failure.limit.name);
    return parseLimitConstraint(
      OPERATION,
      cause.failure.limit.name === "max_entries" ? "capacity" : "memory",
      cause,
      {
        path: input.path,
        retryable: false,
        ...(parameter === undefined
          ? {}
          : {
              remediationAction: budgetRecovery(
                parameter,
                cause.failure.limit.maximum,
              ),
            }),
      },
    );
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
    if (cause.reason === "limit" && cause.fixedAllowance !== undefined)
      return fixedCeilingConstraint(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        cause.fixedAllowance,
        { cause },
      );
    if (cause.reason === "limit" && cause.boundary === "file-size")
      return parseLimitConstraint(
        OPERATION,
        "file-size",
        decodeLimit(
          VSIX_PACKAGE_FORMAT,
          cause.message,
          { name: "max_file_bytes", maximum: input.max_file_bytes },
          { cause },
        ),
        {
          retryable: false,
          remediationAction: budgetRecovery(
            "max_file_bytes",
            input.max_file_bytes,
          ),
        },
      );
    return translateArtifactFailure(OPERATION, cause);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "VS Code extension package",
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

const vsixFailure = (
  cause: unknown,
  input: InspectVsixPackageInput,
  snapshot?: StableArtifactSnapshot,
) =>
  projectStableArtifactFailure(
    cause,
    vsixFailurePrimary(artifactFilePrimaryFacts(cause), input),
    input.path,
    VSIX_PACKAGE_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );

/** Portable parser over one bounded, identity-checked regular file. */
export class VsixPackageProvider {
  readonly identity = VSIX_PACKAGE_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        VSIX_PACKAGE_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectVsixPackageInput,
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
          await parseVsixPackage(
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
      return err(vsixFailure(cause, input, snapshot));
    }
  }
}
