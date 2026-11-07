import {
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  assertArtifactReadActive,
  artifactFileCancellationCause,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { BinaryHardeningPort } from "../../application/binaryDiagnostics/BinaryHardeningPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  BINARY_HARDENING_LIMITATIONS,
  MAX_INSPECT_BINARY_HARDENING_FILE_BYTES,
  type BinaryHardening,
  type InspectBinaryHardeningInput,
} from "../../domain/native/binaryHardening.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok } from "../../domain/result.js";
import { BINARY_HARDENING_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import { readElfHardening } from "./ElfHardening.js";
import { readMachoHardening } from "./MachoHardening.js";
import { readPeHardening } from "./PeHardening.js";

const OPERATION = "inspect_binary_hardening";

/** Portable ELF, PE, and Mach-O hardening reader over one stable regular file. */
export class BinaryHardeningProvider implements BinaryHardeningPort {
  readonly identity = BINARY_HARDENING_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        BINARY_HARDENING_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectBinaryHardeningInput,
    options?: ExecutionOptions,
  ) {
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);
        const report = await readBinaryHardening(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          options?.signal,
        );
        assertArtifactReadActive(options?.signal);
        return ok(report);
      });
    } catch (cause) {
      return err(binaryHardeningFailure(cause, input));
    }
  }
}

/** Dispatch one stable buffer to the ELF, PE, or Mach-O hardening reader. */
export const readBinaryHardening = async (
  bytes: Buffer,
  artifact: BinaryHardening["artifact"],
  signal?: AbortSignal,
): Promise<BinaryHardening> => {
  assertArtifactReadActive(signal);
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  )
    return {
      artifact,
      format: "elf",
      images: [readElfHardening(bytes, signal)],
      limitations: [...BINARY_HARDENING_LIMITATIONS],
    };
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a)
    return {
      artifact,
      format: "pe",
      images: [await readPeHardening(bytes, artifact, signal)],
      limitations: [...BINARY_HARDENING_LIMITATIONS],
    };
  return {
    artifact,
    format: "mach-o",
    images: await readMachoHardening(bytes, signal),
    limitations: [...BINARY_HARDENING_LIMITATIONS],
  };
};

const fileSizeRemediation = (input: InspectBinaryHardeningInput): string =>
  input.max_file_bytes >= MAX_INSPECT_BINARY_HARDENING_FILE_BYTES
    ? `The image exceeds the ${String(MAX_INSPECT_BINARY_HARDENING_FILE_BYTES)}-byte input ceiling this operation accepts. This release has no runtime override. Select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const binaryHardeningFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectBinaryHardeningInput,
): AnalysisError => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause instanceof BinaryResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      `Selected artifact ${input.path}: ${cause.message}`,
      { boundary: cause.boundary, maximum: cause.maximum_bytes },
      {
        cause,
        ...fixedAllowanceOptions(
          "The binary hardening structural allowance",
          "parser",
        ),
      },
    );
  if (cause instanceof BinaryFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          { cause },
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
          remediationAction: fileSizeRemediation(input),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected image could not be read (${String(cause.code)}): ${input.path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(BINARY_HARDENING_PROVIDER.id, OPERATION, {
    cause,
    diagnostics: {
      path: input.path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const binaryHardeningFailure = (
  cause: unknown,
  input: InspectBinaryHardeningInput,
): AnalysisError =>
  projectStableArtifactFailure(
    cause,
    binaryHardeningFailurePrimary(artifactFilePrimaryFacts(cause), input),
    input.path,
    BINARY_HARDENING_PROVIDER.id,
    OPERATION,
  );
