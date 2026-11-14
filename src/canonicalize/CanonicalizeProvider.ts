import {
  projectSelectedArtifactFileFailure,
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
  artifactFileCancellationCause,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { CanonicalizePort } from "../application/canonicalize/CanonicalizePort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import {
  CANONICALIZE_SAMPLE_UNITS,
  MAX_CANONICALIZE_FILE_BYTES,
  type CanonicalizeArtifactInput,
} from "../domain/canonicalize/canonicalizeArtifact.js";
import { canonicalizeArtifactFacts } from "../domain/canonicalize/engine.js";
import { err, ok } from "../domain/result.js";
import { CANONICALIZE_PROVIDER } from "../domain/investigationProviders.js";

const OPERATION = "canonicalize_artifact";

/** Portable canonicalizer over one bounded, identity-checked regular file. */
export class CanonicalizeProvider implements CanonicalizePort {
  readonly identity = CANONICALIZE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        CANONICALIZE_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async canonicalize(
    input: CanonicalizeArtifactInput,
    options?: ExecutionOptions,
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
        const facts = canonicalizeArtifactFacts(snapshot.bytes, input.format, {
          maxFacts: input.max_facts,
          maxDepth: input.max_depth,
          sampleUnits: CANONICALIZE_SAMPLE_UNITS,
        });
        return ok({
          artifact: {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          requested_format: input.format,
          ...facts,
        });
      });
    } catch (cause) {
      return err(canonicalizeFailure(cause, input, snapshot));
    }
  }
}

const inputBudgetRemediation = (input: CanonicalizeArtifactInput): string =>
  input.max_file_bytes >= MAX_CANONICALIZE_FILE_BYTES
    ? `The artifact exceeds the ${String(MAX_CANONICALIZE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const canonicalizeFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: CanonicalizeArtifactInput,
): AnalysisError => {
  const { cause, origin } = facts;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      {
        cause,
      },
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
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction: inputBudgetRemediation(input),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(
        OPERATION,
        { cause, ...stableArtifactInputRecovery(cause) },
        [{ path: ["path"], reason: "invalid_format", message: cause.message }],
      );
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "artifact",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error ? cause.message : "Canonicalization failed.",
    { cause },
  );
};

const canonicalizeFailure = (
  cause: unknown,
  input: CanonicalizeArtifactInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const primary = canonicalizeFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    CANONICALIZE_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
