import { NUGET_NUPKG_PROVIDER_IDENTITY } from "./NugetNupkgProviderIdentity.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  translateArtifactFailure,
  withStableArtifactHandle,
} from "../resources/index.js";
import {
  isParseLimit,
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
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import { parseNugetNupkg } from "./NugetNupkgParser.js";

const OPERATION = "inspect_nuget_nupkg";

const budgetRecovery = (
  parameter: keyof typeof NUGET_NUPKG_LIMIT_MAXIMA,
  selected: number,
): string =>
  selected >= NUGET_NUPKG_LIMIT_MAXIMA[parameter]
    ? `${parameter} is at this operation's maximum of ${String(NUGET_NUPKG_LIMIT_MAXIMA[parameter])}; select a complete artifact within that bound.`
    : `Raise ${parameter} above ${String(selected)}, up to ${String(NUGET_NUPKG_LIMIT_MAXIMA[parameter])}, or select a smaller artifact. The budget applies on the next call; repeating the unchanged request does not raise it.`;

const nupkgFailure = (
  cause: unknown,
  input: InspectNugetNupkgInput,
  identity?: { readonly sha256: string; readonly bytes: number },
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: NUGET_NUPKG_PROVIDER_IDENTITY.id,
      operation: OPERATION,
      path: input.path,
      description: "NuGet package",
      recognise: (failure, origin) => {
        if (isParseLimit(failure, NUGET_NUPKG_FORMAT)) {
          const parameter = (
            Object.keys(
              NUGET_NUPKG_LIMIT_MAXIMA,
            ) as (keyof typeof NUGET_NUPKG_LIMIT_MAXIMA)[]
          ).find((name) => name === failure.failure.limit.name);
          return parseLimitConstraint(
            OPERATION,
            failure.failure.limit.name === "max_entries"
              ? "capacity"
              : "memory",
            failure,
            {
              path: input.path,
              retryable: false,
              ...(parameter === undefined
                ? {}
                : {
                    remediationAction: budgetRecovery(
                      parameter,
                      failure.failure.limit.maximum,
                    ),
                  }),
            },
          );
        }
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure
        ) {
          if (
            failure.reason === "limit" &&
            failure.fixedAllowance !== undefined
          )
            return fixedCeilingConstraint(
              OPERATION,
              failure.boundary ?? "memory",
              failure.message,
              failure.fixedAllowance,
              { cause: failure },
            );
          if (failure.reason === "limit" && failure.boundary === "file-size")
            return undefined;
          if (
            failure.reason !== "path" &&
            failure.reason !== "integrity" &&
            failure.reason !== "cancelled"
          )
            return translateArtifactFailure(OPERATION, failure);
        }
        return undefined;
      },
      fileSize: (failure) =>
        parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            NUGET_NUPKG_FORMAT,
            failure.message,
            { name: "max_file_bytes", maximum: input.max_file_bytes },
            { cause: failure },
          ),
          {
            retryable: false,
            remediationAction: budgetRecovery(
              "max_file_bytes",
              input.max_file_bytes,
            ),
          },
        ),
      unclassified: (failure) =>
        new ArtifactOperationError(
          OPERATION,
          "io",
          undefined,
          errorMessage(failure),
          { cause: failure },
        ),
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    NUGET_NUPKG_PROVIDER_IDENTITY.id,
    OPERATION,
    identity,
  );
};

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
