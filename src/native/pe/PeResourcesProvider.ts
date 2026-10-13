import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import type { PeResourcesPort } from "../../application/binaryDiagnostics/PeResourcesPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import type { InspectPeResourcesInput } from "../../domain/native/peResources.js";
import { err, ok } from "../../domain/result.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { PE_RESOURCES_PROVIDER } from "../../application/InvestigationProviders.js";
import { parsePeResources } from "./PeResourceParser.js";

/** Portable parser over one bounded, identity-checked regular file. */
export class PeResourcesProvider implements PeResourcesPort {
  readonly identity = PE_RESOURCES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return this.#resources.close();
  }

  async inspect(input: InspectPeResourcesInput, options?: ExecutionOptions) {
    try {
      const snapshot = await this.#resources.run(() =>
        readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        ),
      );
      return ok(
        await parsePeResources(
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
    } catch (cause) {
      return err(peResourcesFailure(cause, input, options?.signal));
    }
  }
}

const peResourcesFailurePrimary = (
  cause: unknown,
  input: InspectPeResourcesInput,
  signal: AbortSignal | undefined,
) => {
  const operation = "inspect_pe_resources";
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(
      operation,
      input.path,
      cause.message,
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(operation, { cause });
  if (signal?.aborted) return new AnalysisCancelledError(operation, { cause });

  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_entries: input.max_entries,
        },
        { cause },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: cause.message,
        },
      ]);
  }

  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, input.path, cause.code, {
        cause,
      });
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected PE image could not be read (${cause.code}): ${input.path}.`,
        },
      ]);
  }

  return new ArtifactOperationError(
    operation,
    cause instanceof ArtifactReaderFailure ? cause.reason : "io",
    undefined,
    cause instanceof Error ? cause.message : "PE artifact inspection failed.",
    { cause },
  );
};

const peResourcesFailure = (
  cause: unknown,
  input: InspectPeResourcesInput,
  signal: AbortSignal | undefined,
) => {
  const primary = peResourcesFailurePrimary(cause, input, signal);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    PE_RESOURCES_PROVIDER.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: "inspect_pe_resources", cause },
  );
  return analysisErrorWithCleanupFailure(
    primary,
    cleanup,
    "inspect_pe_resources",
  );
};
