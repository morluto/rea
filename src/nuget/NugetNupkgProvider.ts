import { NUGET_NUPKG_PROVIDER_IDENTITY } from "./NugetNupkgProviderIdentity.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  projectArtifactCloseFailure,
  projectOwnedArtifactIdentityFailure,
  projectOwnedArtifactInputFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  translateArtifactFailure,
  withStableArtifactHandle,
  type ArtifactFilePrimaryFacts,
} from "../resources/index.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { decodeLimit } from "../domain/parseFailure.js";
import { fixedCeilingConstraint } from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  NUGET_NUPKG_FORMAT,
  NUGET_NUPKG_LIMIT_MAXIMA,
  type InspectNugetNupkgInput,
} from "../domain/nuget/nupkg.js";
import { err, ok } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { parseNugetNupkg } from "./NugetNupkgParser.js";

const OPERATION = "inspect_nuget_nupkg";

const budgetRecovery = (
  parameter: keyof typeof NUGET_NUPKG_LIMIT_MAXIMA,
  selected: number,
): string =>
  selected >= NUGET_NUPKG_LIMIT_MAXIMA[parameter]
    ? `${parameter} is at this operation's maximum of ${String(NUGET_NUPKG_LIMIT_MAXIMA[parameter])}; select a complete artifact within that bound.`
    : `Raise ${parameter} above ${String(selected)}, up to ${String(NUGET_NUPKG_LIMIT_MAXIMA[parameter])}, or select a smaller artifact. The budget applies on the next call; repeating the unchanged request does not raise it.`;

const nupkgFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectNugetNupkgInput,
) => {
  const { cause, origin } = facts;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (isParseLimit(cause, NUGET_NUPKG_FORMAT)) {
    const parameter = (
      Object.keys(
        NUGET_NUPKG_LIMIT_MAXIMA,
      ) as (keyof typeof NUGET_NUPKG_LIMIT_MAXIMA)[]
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
          NUGET_NUPKG_FORMAT,
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
    "NuGet package",
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

const nupkgFailure = (
  cause: unknown,
  input: InspectNugetNupkgInput,
  identity?: { readonly sha256: string; readonly bytes: number },
) =>
  projectStableArtifactFailure(
    cause,
    nupkgFailurePrimary(artifactFilePrimaryFacts(cause), input),
    input.path,
    NUGET_NUPKG_PROVIDER_IDENTITY.id,
    OPERATION,
    identity,
  );

/** Portable parser over one bounded, identity-checked regular file. */
export class NugetNupkgProvider {
  readonly identity = NUGET_NUPKG_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        NUGET_NUPKG_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectNugetNupkgInput,
    options?: { readonly signal?: AbortSignal },
  ) {
    let identity:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () =>
        withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
            retainBytes: () => 4,
            signal: options?.signal,
            resourceScope: this.#resources,
            onIdentity: (verified) => {
              identity = verified;
            },
          },
          async ({ prefix, size, sha256, readRange }) =>
            ok(
              await parseNugetNupkg(
                { prefix, size, readRange },
                { path: input.path, sha256, bytes: size },
                input,
                options?.signal,
              ),
            ),
        ),
      );
    } catch (cause) {
      return err(nupkgFailure(cause, input, identity));
    }
  }
}
