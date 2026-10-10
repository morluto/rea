import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import type { PeResourcesPort } from "../../application/binaryDiagnostics/PeResourcesPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import type { InspectPeResourcesInput } from "../../domain/native/peResources.js";
import { err, ok } from "../../domain/result.js";
import { PE_RESOURCES_PROVIDER } from "../../application/InvestigationProviders.js";
import { parsePeResources } from "./PeResourceParser.js";

/** Portable parser over one bounded, identity-checked regular file. */
export class PeResourcesProvider implements PeResourcesPort {
  readonly identity = PE_RESOURCES_PROVIDER;

  async inspect(input: InspectPeResourcesInput, options?: ExecutionOptions) {
    try {
      const snapshot = await readStableArtifact(
        input.path,
        input.max_file_bytes,
        options?.signal,
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
      if (options?.signal?.aborted)
        return err(
          new AnalysisCancelledError("inspect_pe_resources", { cause }),
        );
      if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
        return err(
          new AnalysisResourceConstraintError(
            "inspect_pe_resources",
            "memory",
            cause.message,
            {
              max_file_bytes: input.max_file_bytes,
              max_entries: input.max_entries,
            },
            { cause },
          ),
        );
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "EACCES" || cause.code === "EPERM")
      )
        return err(
          new AnalysisAccessDeniedError(
            "inspect_pe_resources",
            input.path,
            cause.code,
            { cause },
          ),
        );
      return err(
        new ArtifactOperationError(
          "inspect_pe_resources",
          cause instanceof ArtifactReaderFailure ? cause.reason : "io",
          undefined,
          cause instanceof Error
            ? cause.message
            : "PE artifact inspection failed.",
          { cause },
        ),
      );
    }
  }
}
