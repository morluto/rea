import {
  ArtifactReaderFailure,
  projectOwnedArtifactInputFailure,
  type ArtifactFilePrimaryFacts,
} from "../resources/index.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { parseFailureAnalysisError } from "../domain/parseFailureAnalysisError.js";
import type { ProviderFailureDialect } from "./classifyProviderFailure.js";

type ArtifactOperation = ConstructorParameters<
  typeof ArtifactOperationError
>[0];

interface OfflineArtifactDialectBase {
  readonly providerId: string;
  readonly path: string;
  readonly description: string;
  /** The request field that selected the file; `path` when omitted. */
  readonly field?: string;
  /**
   * Format- or provider-specific errors examined before the shared
   * `ParseFailureError`, owned input, and selected-file projections.
   */
  readonly recognise?: (
    cause: unknown,
    origin: ArtifactFilePrimaryFacts["origin"],
  ) => AnalysisError | undefined;
  /** Projection for a selected file exceeding the caller's `file-size` budget. */
  readonly fileSize?: (cause: ArtifactReaderFailure) => AnalysisError;
}

export type OfflineArtifactDialectOptions =
  | (OfflineArtifactDialectBase & {
      readonly operation: ArtifactOperation;
      readonly fallbackMessage: string;
      readonly unclassified?: (
        cause: unknown,
        origin: ArtifactFilePrimaryFacts["origin"],
      ) => AnalysisError;
    })
  | (OfflineArtifactDialectBase & {
      readonly operation: string;
      readonly fallbackMessage?: never;
      readonly unclassified: (
        cause: unknown,
        origin: ArtifactFilePrimaryFacts["origin"],
      ) => AnalysisError;
    });

/**
 * Shared `ProviderFailureDialect` for offline single-file artifact providers:
 * classifies provider-specific refusals, `ParseFailureError`, owned artifact
 * input errors, and selected-file errors through `classifyProviderFailure`.
 */
export const offlineArtifactFailureDialect = (
  facts: ArtifactFilePrimaryFacts,
  options: OfflineArtifactDialectOptions,
): ProviderFailureDialect => {
  const { operation, providerId, path, description, field } = options;
  const { origin } = facts;
  return {
    providerId,
    operation,
    recognise: (failure) =>
      options.recognise?.(failure, origin) ??
      (options.fileSize !== undefined &&
      origin === "owned-or-classified" &&
      failure instanceof ArtifactReaderFailure &&
      failure.reason === "limit" &&
      (failure.boundary === "file-size" || failure.boundary === undefined)
        ? options.fileSize(failure)
        : undefined) ??
      parseFailureAnalysisError(operation, path, failure, field) ??
      projectOwnedArtifactInputFailure(facts, operation, path, field),
    file: {
      path,
      description,
      ...(field === undefined ? {} : { field }),
      ...(options.fileSize === undefined ? {} : { fileSize: options.fileSize }),
    },
    unclassified: (failure) =>
      options.fallbackMessage === undefined
        ? options.unclassified(failure, origin)
        : options.unclassified !== undefined
          ? options.unclassified(failure, origin)
          : new ArtifactOperationError(
              options.operation,
              origin === "owned-or-classified" &&
                failure instanceof ArtifactReaderFailure
                ? failure.reason
                : "io",
              undefined,
              failure instanceof Error
                ? failure.message
                : options.fallbackMessage,
              { cause: failure },
            ),
  };
};
