import { maxFileBytesReadBudget } from "../../domain/artifactReadBudget.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import {
  artifactFileCeilingConstraint,
  artifactReadBudgetConstraint,
  projectStableArtifactFailure,
  closeArtifactResources,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  yieldArtifactRead,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { NativeExportsPort } from "../../ports/binaryDiagnostics/NativeExportsPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  DEFAULT_NATIVE_EXPORTS_READ_BYTES,
  MAX_INSPECT_NATIVE_EXPORTS_FILE_BYTES,
  type InspectNativeExportsInput,
} from "../../domain/native/nativeExports.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok } from "../../domain/result.js";
import { NATIVE_EXPORTS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
  binaryResourceAllowance,
} from "../../domain/binaryContainer.js";
import {
  NATIVE_EXPORT_LIMITS,
  type NativeExportLimit,
  parseNativeExportsFromHandle,
} from "../../domain/native/nativeExportParser.js";
import { errorMessage } from "../../kernel/errorMessage.js";

const OPERATION = "inspect_native_exports";
const HEADER_PREFIX_BYTES = 4096;

/** Portable export-table reader over one bounded, identity-checked regular file. */
export class NativeExportsProvider implements NativeExportsPort {
  readonly identity = NATIVE_EXPORTS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      NATIVE_EXPORTS_PROVIDER,
      OPERATION,
    );
  }

  async inspect(input: InspectNativeExportsInput, options?: ExecutionOptions) {
    const signal = options?.signal;
    let snapshot:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle(
          input.path,
          MAX_INSPECT_NATIVE_EXPORTS_FILE_BYTES,
          {
            readBudget: maxFileBytesReadBudget(
              input.max_file_bytes,
              MAX_INSPECT_NATIVE_EXPORTS_FILE_BYTES,
              DEFAULT_NATIVE_EXPORTS_READ_BYTES,
            ),
            signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              snapshot = identity;
            },
          },
          (handle) =>
            parseNativeExportsFromHandle(
              {
                size: handle.size,
                prefix: handle.prefix,
                readRange: (offset, length) => handle.readRange(offset, length),
              },
              { path: input.path, sha256: handle.sha256, bytes: handle.size },
              () => yieldArtifactRead(signal),
            ),
        );
        assertArtifactReadActive(signal);
        return ok(report);
      });
    } catch (cause) {
      return err(nativeExportsFailure(cause, input, snapshot));
    }
  }
}

/** Recovery for one exhausted allowance, chosen from the parser's structured tag. */
const limitRecovery = (
  limit: NativeExportLimit | null,
  cause: BinaryResourceFailure,
): ResourceConstraintRecovery => {
  const maximum = cause.maximum_bytes;
  switch (limit) {
    case "rows":
      return fixedAllowanceOptions(
        "The native export inventory allowance",
        "count",
        { limit: maximum, unit: "entries" },
      );
    case "retained_text":
      return fixedAllowanceOptions(
        "The native export retained-text allowance",
        "bytes",
        { limit: maximum, unit: "bytes" },
      );
    case null:
      return fixedAllowanceOptions(
        "The native export structural decoding allowance",
        "parser",
        binaryResourceCeiling(cause),
      );
  }
};

const nativeExportsFailure = (
  cause: unknown,
  input: InspectNativeExportsInput,
  snapshot?: { readonly sha256: string; readonly bytes: number },
): AnalysisError => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: NATIVE_EXPORTS_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "image",
      recognise: (failure) =>
        artifactReadBudgetConstraint(OPERATION, failure, {
          max_file_bytes: input.max_file_bytes,
        }) ??
        (failure instanceof BinaryResourceFailure
          ? parseLimitConstraint(OPERATION, "capacity", failure, {
              path: input.path,
              ...limitRecovery(
                binaryResourceAllowance(failure, NATIVE_EXPORT_LIMITS),
                failure,
              ),
            })
          : undefined),
      fileSize: (failure) =>
        artifactFileCeilingConstraint(
          OPERATION,
          failure,
          {
            name: "The native exports whole-file ceiling",
            bytes: MAX_INSPECT_NATIVE_EXPORTS_FILE_BYTES,
          },
          {
            max_file_bytes: input.max_file_bytes,
          },
        ),
      unclassified: (failure) =>
        new ProviderAdapterError(NATIVE_EXPORTS_PROVIDER.id, OPERATION, {
          cause: failure,
          diagnostics: {
            path: input.path,
            reason: errorMessage(failure),
          },
        }),
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    NATIVE_EXPORTS_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
