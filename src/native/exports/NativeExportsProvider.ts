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
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import {
  DEFAULT_NATIVE_EXPORTS_READ_BYTES,
  MAX_INSPECT_NATIVE_EXPORTS_FILE_BYTES,
  nativeExportBudgetLimit,
  type InspectNativeExportsInput,
} from "../../domain/native/nativeExports.js";
import { err, ok } from "../../domain/result.js";
import { NATIVE_EXPORTS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryResourceFailure,
  binaryResourceAllowance,
  DEFAULT_NATIVE_STRUCTURE_BYTES,
  isNativeStructureFailure,
} from "../../domain/binaryContainer.js";
import { nativeStructureConstraint } from "../../domain/native/nativeStructureBudget.js";
import {
  NATIVE_EXPORT_LIMITS,
  type NativeExportLimit,
  parseNativeExportsFromHandle,
} from "../../domain/native/nativeExportParser.js";

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
              handle,
              { path: input.path, sha256: handle.sha256, bytes: handle.size },
              () => yieldArtifactRead(signal),
              {
                rows: input.max_entries,
                textBytes: input.max_text_bytes,
                structureBytes:
                  input.max_structure_bytes ?? DEFAULT_NATIVE_STRUCTURE_BYTES,
              },
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

/** The control a parser inventory limit names; a declared table count is the complete need. */
const inventoryLimit = (
  limit: NativeExportLimit,
  cause: BinaryResourceFailure,
) => {
  const { required } = cause.failure.limit;
  return {
    ...nativeExportBudgetLimit(
      limit === "rows" ? "max_entries" : "max_text_bytes",
      cause.maximum_bytes,
    ),
    ...(typeof required === "number" ? { required_value: required } : {}),
  };
};

const exportInventoryConstraint = (
  failure: BinaryResourceFailure,
  path: string,
): AnalysisResourceConstraintError | undefined => {
  const limit = binaryResourceAllowance(failure, NATIVE_EXPORT_LIMITS);
  return limit === null
    ? undefined
    : parseLimitConstraint(OPERATION, "capacity", failure, {
        path,
        retryable: false,
        limit: inventoryLimit(limit, failure),
      });
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
        (isNativeStructureFailure(failure)
          ? nativeStructureConstraint(OPERATION, failure, input.path)
          : failure instanceof BinaryResourceFailure
            ? exportInventoryConstraint(failure, input.path)
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
