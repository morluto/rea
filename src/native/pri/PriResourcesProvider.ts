import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import type { PriResourcesPort } from "../../application/binaryDiagnostics/PriResourcesPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import type { InspectPriResourcesInput } from "../../domain/native/priResources.js";
import { err, ok } from "../../domain/result.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { PRI_RESOURCES_PROVIDER } from "../../domain/investigationProviders.js";
import { parsePriResources } from "./PriResourceParser.js";

const OPERATION = "inspect_pri_resources";

/** Portable PRI parser over one bounded, identity-checked regular file. */
export class PriResourcesProvider implements PriResourcesPort {
  readonly identity = PRI_RESOURCES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return this.#resources.close();
  }

  async inspect(input: InspectPriResourcesInput, options?: ExecutionOptions) {
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
        await parsePriResources(
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
      return err(priResourcesFailure(cause, input, options?.signal));
    }
  }
}

const priResourcesFailurePrimary = (
  cause: unknown,
  input: InspectPriResourcesInput,
  signal: AbortSignal | undefined,
) => {
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, { cause });
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION, { cause });

  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        { cause },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: cause.message,
        },
      ]);
  }

  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected PRI file could not be read (${cause.code}): ${input.path}.`,
        },
      ]);
  }

  return new ArtifactOperationError(
    OPERATION,
    cause instanceof ArtifactReaderFailure ? cause.reason : "io",
    undefined,
    cause instanceof Error ? cause.message : "PRI artifact inspection failed.",
    { cause },
  );
};

const priResourcesFailure = (
  cause: unknown,
  input: InspectPriResourcesInput,
  signal: AbortSignal | undefined,
) => {
  const primary = priResourcesFailurePrimary(cause, input, signal);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    PRI_RESOURCES_PROVIDER.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  return analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
};
