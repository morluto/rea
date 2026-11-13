import { NUGET_NUPKG_PROVIDER_IDENTITY } from "./NugetNupkgProviderIdentity.js";
import {
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
  projectArtifactCloseFailure,
} from "../artifacts/StableArtifactFailure.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  type StableArtifactSnapshot,
  readStableArtifact,
} from "../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactSelectedPathErrno,
  artifactFileCancellationCause,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { NugetNupkgPort } from "../application/nuget/NugetNupkgPort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_NUGET_NUPKG_ENTRIES,
  MAX_INSPECT_NUGET_NUPKG_FILE_BYTES,
  MAX_INSPECT_NUGET_NUPKG_NUSPEC_BYTES,
  type InspectNugetNupkgInput,
} from "../domain/nuget/nupkg.js";
import { err, ok } from "../domain/result.js";
import {
  NugetNupkgCapacityFailure,
  NugetNupkgFormatFailure,
} from "./NugetNupkg.errors.js";
import { parseNugetNupkg } from "./NugetNupkgParser.js";

const OPERATION = "inspect_nuget_nupkg";

const inputBudgetRemediation = (
  cause: ArtifactReaderFailure,
  input: InspectNugetNupkgInput,
): string | undefined => {
  if (cause.boundary === "file-size")
    return input.max_file_bytes >= MAX_INSPECT_NUGET_NUPKG_FILE_BYTES
      ? `The file exceeds the ${String(MAX_INSPECT_NUGET_NUPKG_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;
  if (!(cause instanceof NugetNupkgCapacityFailure)) return undefined;
  switch (cause.resource) {
    case "max_entries":
      return cause.maximum >= MAX_INSPECT_NUGET_NUPKG_ENTRIES
        ? `The file exceeds the ${String(MAX_INSPECT_NUGET_NUPKG_ENTRIES)}-entry ceiling this operation accepts; select a smaller artifact.`
        : `Raise max_entries above ${String(cause.maximum)} or select a smaller artifact; the limit is the caller-selected entry budget.`;
    case "max_nuspec_bytes":
      return cause.maximum >= MAX_INSPECT_NUGET_NUPKG_NUSPEC_BYTES
        ? `The .nuspec exceeds the ${String(MAX_INSPECT_NUGET_NUPKG_NUSPEC_BYTES)}-byte ceiling this operation accepts; select a smaller artifact.`
        : `Raise max_nuspec_bytes above ${String(cause.maximum)} or select a smaller artifact; the limit is the caller-selected .nuspec budget.`;
    case "max_file_bytes":
      return input.max_file_bytes >= MAX_INSPECT_NUGET_NUPKG_FILE_BYTES
        ? `The file exceeds the ${String(MAX_INSPECT_NUGET_NUPKG_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
        : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;
  }
};

const nupkgFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectNugetNupkgInput,
) => {
  const { cause, origin } = facts;
  if (cause instanceof NugetNupkgFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          { cause },
        )
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected NuGet package ${input.path}: ${cause.message}`,
          },
        ]);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
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
          max_entries: input.max_entries,
          max_nuspec_bytes: input.max_nuspec_bytes,
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
      return new AnalysisInputError(
        OPERATION,
        { cause, ...stableArtifactInputRecovery(cause) },
        [
          {
            path: ["path"],
            reason: "invalid_format",
            message: cause.message,
          },
        ],
      );
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    const pathErrno = artifactSelectedPathErrno(cause);
    if (pathErrno !== undefined)
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected NuGet package could not be read (${pathErrno}): ${input.path}.`,
        },
      ]);
  }
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error ? cause.message : "NuGet package inspection failed.",
    { cause },
  );
};

const nupkgFailure = (
  cause: unknown,
  input: InspectNugetNupkgInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const primary = nupkgFailurePrimary(artifactFilePrimaryFacts(cause), input);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    NUGET_NUPKG_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};

/** Portable parser over one bounded, identity-checked regular file. */
export class NugetNupkgProvider implements NugetNupkgPort {
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

  async inspect(input: InspectNugetNupkgInput, options?: ExecutionOptions) {
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
          await parseNugetNupkg(
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
      return err(nupkgFailure(cause, input, snapshot));
    }
  }
}
