import {
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  imageFileSizeRemediation,
  projectSelectedArtifactFileFailure,
  projectOwnedArtifactIdentityFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  assertArtifactReadActive,
  yieldArtifactRead,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { NativeExportsPort } from "../../ports/binaryDiagnostics/NativeExportsPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
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

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        NATIVE_EXPORTS_PROVIDER.id,
        OPERATION,
      );
    }
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
          input.max_file_bytes,
          {
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

const nativeExportsFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectNativeExportsInput,
): AnalysisError => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (cause instanceof BinaryResourceFailure)
    return parseLimitConstraint(OPERATION, "capacity", cause, {
      path: input.path,
      ...limitRecovery(
        binaryResourceAllowance(cause, NATIVE_EXPORT_LIMITS),
        cause,
      ),
    });
  const formatFailure = parseFailureAnalysisError(OPERATION, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction: imageFileSizeRemediation(
            input.max_file_bytes,
            MAX_INSPECT_NATIVE_EXPORTS_FILE_BYTES,
          ),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "image",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ProviderAdapterError(NATIVE_EXPORTS_PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      path: input.path,
      reason: errorMessage(cause),
    },
  });
};

const nativeExportsFailure = (
  cause: unknown,
  input: InspectNativeExportsInput,
  snapshot?: { readonly sha256: string; readonly bytes: number },
): AnalysisError => {
  const primary = nativeExportsFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
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
