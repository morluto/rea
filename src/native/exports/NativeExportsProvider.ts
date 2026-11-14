import {
  imageFileSizeRemediation,
  projectSelectedArtifactFileFailure,
  projectOwnedArtifactIdentityFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  type StableArtifactSnapshot,
  readStableArtifact,
} from "../../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  assertArtifactReadActive,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { NativeExportsPort } from "../../application/binaryDiagnostics/NativeExportsPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_NATIVE_EXPORTS_FILE_BYTES,
  type InspectNativeExportsInput,
} from "../../domain/native/nativeExports.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok } from "../../domain/result.js";
import { NATIVE_EXPORTS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import {
  NativeExportLimitFailure,
  type NativeExportLimit,
  parseNativeExports,
} from "./NativeExportParser.js";

const OPERATION = "inspect_native_exports";

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
        assertArtifactReadActive(options?.signal);
        const report = parseNativeExports(snapshot.bytes, {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        });
        assertArtifactReadActive(options?.signal);
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
  maximum: number,
): ResourceConstraintRecovery => {
  switch (limit) {
    case "rows":
      return fixedAllowanceOptions(
        `The ${String(maximum)}-entry native export inventory allowance`,
        "count",
      );
    case "retained_text":
      return fixedAllowanceOptions(
        `The ${String(maximum)}-byte native export retained-text allowance`,
        "bytes",
      );
    case null:
      return fixedAllowanceOptions(
        "The native export structural decoding allowance",
        "parser",
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
    return new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      `Selected artifact ${input.path}: ${cause.message}`,
      { boundary: cause.boundary, maximum: cause.maximum_bytes },
      {
        cause,
        ...limitRecovery(
          cause instanceof NativeExportLimitFailure ? cause.limit : null,
          cause.maximum_bytes,
        ),
      },
    );
  if (cause instanceof BinaryFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          {
            cause,
          },
        )
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${input.path}: ${cause.message}`,
          },
        ]);
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
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const nativeExportsFailure = (
  cause: unknown,
  input: InspectNativeExportsInput,
  snapshot?: StableArtifactSnapshot,
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
