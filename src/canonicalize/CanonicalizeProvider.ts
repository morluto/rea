import {
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
  completedStableArtifactObservation,
  ArtifactResourceScope,
} from "../resources/index.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import type { CanonicalizePort } from "../ports/canonicalize/CanonicalizePort.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  CANONICALIZE_SAMPLE_UNITS,
  MAX_CANONICALIZE_FILE_BYTES,
  type CanonicalizeArtifactInput,
} from "../domain/canonicalize/canonicalizeArtifact.js";
import { canonicalizeArtifactFacts } from "../domain/canonicalize/engine.js";
import {
  unrecognizedRequestedFacts,
  type NormalizedArtifactFacts,
  type NormalizerBudget,
} from "../domain/canonicalize/normalizer.js";
import { canonicalizeAsarBytes, looksLikeAsar } from "./asarCanonicalize.js";
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
        const budget: NormalizerBudget = {
          maxFacts: input.max_facts,
          maxDepth: input.max_depth,
          sampleUnits: CANONICALIZE_SAMPLE_UNITS,
        };
        const facts = await this.#canonicalizeBytes(
          snapshot.bytes,
          input.format,
          budget,
          options?.signal,
        );
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
      const failure = classifyProviderFailure(
        cause,
        canonicalizeFailureDialect(input),
      );
      // A parse failure after a completed read (e.g. a malformed ASAR header)
      // carries no read identity in its cause, so retain the snapshot's.
      if (failure.partialObservation === undefined && snapshot !== undefined) {
        const observation = completedStableArtifactObservation(
          cause,
          input.path,
          snapshot,
        );
        if (observation !== undefined)
          failure.retainPartialObservation(observation);
      }
      return err(failure);
    }
  }

  /**
   * Route to the byte-based domain engine for WASM and JSON, or to the ASAR
   * adapter, which reuses REA's owning ASAR reader. An explicit `asar` request
   * whose framing is not recognized reports an unverified result rather than
   * falling through to another format.
   */
  async #canonicalizeBytes(
    bytes: Buffer,
    format: CanonicalizeArtifactInput["format"],
    budget: NormalizerBudget,
    signal: AbortSignal | undefined,
  ): Promise<NormalizedArtifactFacts> {
    if (format === "asar")
      return looksLikeAsar(bytes)
        ? canonicalizeAsarBytes(bytes, budget, signal)
        : unrecognizedRequestedFacts("asar");
    if (format === "auto" && looksLikeAsar(bytes))
      return canonicalizeAsarBytes(bytes, budget, signal);
    return canonicalizeArtifactFacts(bytes, format, budget);
  }
}

const inputBudgetRemediation = (input: CanonicalizeArtifactInput): string =>
  input.max_file_bytes >= MAX_CANONICALIZE_FILE_BYTES
    ? `The artifact exceeds the ${String(MAX_CANONICALIZE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

/**
 * Supply what only this pass owns, so the shared classifier makes every
 * read decision once: integrity, cancellation and path/format failures go
 * through the stable-artifact projections, leaving the file-size budget and
 * the unrecognised-cause fallback here.
 */
const canonicalizeFailureDialect = (
  input: CanonicalizeArtifactInput,
): ProviderFailureDialect => ({
  providerId: CANONICALIZE_PROVIDER.id,
  operation: OPERATION,
  file: {
    path: input.path,
    description: "artifact",
    fileSize: (cause, details) =>
      new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          ...details,
          retryable: false,
          remediationAction: inputBudgetRemediation(input),
        },
      ),
    retainCompletedIdentity: true,
  },
  unclassified: (cause, details) =>
    new ArtifactOperationError(
      OPERATION,
      cause instanceof ArtifactReaderFailure ? cause.reason : "io",
      undefined,
      cause instanceof Error ? cause.message : "Canonicalization failed.",
      { ...details, cause },
    ),
});
