import {
  ArtifactReaderFailure,
  projectOwnedArtifactInputFailure,
  type ArtifactFilePrimaryFacts,
  type RequestField,
  artifactOperationReason,
} from "../resources/index.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { parseFailureAnalysisError } from "../domain/parseFailureAnalysisError.js";
import type { ProviderFailureDialect } from "./classifyProviderFailure.js";

type ArtifactOperation = ConstructorParameters<
  typeof ArtifactOperationError
>[0];

export type OfflineArtifactDialectOptions = {
  readonly providerId: string;
  readonly path: string;
  readonly description: string;
  /** The request field that selected the file; `path` when omitted. */
  readonly field?: RequestField;
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
  /** A provider-specific projection for failures outside the shared file and parser cases. */
  readonly unclassified?: (
    cause: unknown,
    origin: ArtifactFilePrimaryFacts["origin"],
  ) => AnalysisError;
} & (
  | { readonly operation: ArtifactOperation; readonly fallbackMessage: string }
  | { readonly operation: string; readonly fallbackMessage?: never }
);

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
      parseFailureAnalysisError(operation, path, failure) ??
      projectOwnedArtifactInputFailure(facts, operation, path, field),
    file: {
      path,
      description,
      ...(field === undefined ? {} : { field }),
      ...(options.fileSize === undefined ? {} : { fileSize: options.fileSize }),
    },
    unclassified: (failure) => {
      if (options.unclassified !== undefined)
        return options.unclassified(failure, origin);
      if (options.fallbackMessage !== undefined)
        return new ArtifactOperationError(
          options.operation,
          origin === "owned-or-classified" &&
            failure instanceof ArtifactReaderFailure
            ? artifactOperationReason(failure)
            : "io",
          undefined,
          failure instanceof Error ? failure.message : options.fallbackMessage,
          { cause: failure },
        );
      return new ProviderAdapterError(providerId, operation, {
        cause: failure,
        diagnostics: { path, reason: errorMessage(failure) },
      });
    },
  };
};
