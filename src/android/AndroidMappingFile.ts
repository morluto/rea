import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  ArtifactReaderFailure,
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
  readerIntegrityFailure,
  type ArtifactResourceScope,
  readStableArtifact,
} from "../resources/index.js";
import {
  ANDROID_MAPPING_LIMITS,
  type AndroidMappingSource,
} from "../domain/android/androidMapping.js";
import { parseProguardMapping } from "../domain/android/proguardMapping.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { isSelectedRegularFileError } from "../filesystem/RegularFile.js";
import { jadxOperationTimeoutGuidance } from "./JadxOperationTimeout.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { errorMessage } from "../kernel/errorMessage.js";

export interface AndroidMappingReadDeadline {
  readonly timeout: AbortSignal;
  readonly timeoutMs: number;
}

interface MappingRead {
  readonly path: string;
  readonly operation: string;
  readonly signal: AbortSignal;
  readonly deadline: AndroidMappingReadDeadline | undefined;
}

/** Select the first recorded interruption before cleanup changes its outer tag. */
const mappingInterruption = (
  read: MappingRead,
  cause: unknown,
): AnalysisError =>
  read.deadline?.timeout.aborted === true &&
  cause === read.deadline.timeout.reason
    ? new AnalysisTimeoutError(read.operation, read.deadline.timeoutMs, {
        cause,
        ...jadxOperationTimeoutGuidance(read.deadline.timeoutMs),
      })
    : cancelledBy(read.operation, carriedReason(cause));

const invalidMapping = (
  read: MappingRead,
  reason: "invalid_value" | "invalid_format",
  message: string,
  options?: ConstructorParameters<typeof AnalysisInputError>[1],
) =>
  new AnalysisInputError(read.operation, options, [
    { path: ["mapping_path"], reason, message },
  ]);

/** Classify the read's primary failure as the caller's selection where it is one. */
const readFailurePrimary = (
  cause: unknown,
  read: MappingRead,
): AnalysisError => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = facts.cause;
  const owned =
    facts.origin === "owned-or-classified" &&
    primary instanceof ArtifactReaderFailure
      ? primary
      : undefined;
  if (owned?.reason === "cancelled")
    return mappingInterruption(read, artifactFileCancellationCause(owned));
  if (owned?.reason === "limit")
    return new AnalysisResourceConstraintError(
      read.operation,
      "file-size",
      owned.message,
      { maximum_bytes: ANDROID_MAPPING_LIMITS.fileBytes },
      {
        cause: owned,
        retryable: false,
        remediationAction:
          "Select a mapping file within the fixed mapping byte limit.",
      },
    );
  if (owned?.reason === "integrity")
    return readerIntegrityFailure(read.operation, read.path, owned);
  if (owned?.reason === "path")
    return invalidMapping(read, "invalid_value", owned.message, {
      cause: owned,
      ...stableArtifactInputRecovery(owned),
    });
  if (primary instanceof Error && "code" in primary) {
    if (primary.code === "EACCES" || primary.code === "EPERM")
      return new AnalysisAccessDeniedError(
        read.operation,
        read.path,
        primary.code,
        { cause: primary },
      );
    if (isSelectedRegularFileError(primary))
      return invalidMapping(
        read,
        "invalid_value",
        `Selected mapping file could not be read (${primary.code}): ${read.path}`,
        { cause: primary },
      );
  }
  // The scope can refuse admission during shutdown before any physical read.
  if (
    owned?.reason === "unavailable" &&
    owned.cleanup === undefined &&
    read.signal.aborted
  )
    return mappingInterruption(read, read.signal.reason);
  return new ProviderAdapterError("jadx", read.operation, {
    cause: primary,
    diagnostics: {
      mapping_path: read.path,
      reason: errorMessage(primary),
    },
  });
};

/** Preserve the read's outcome, any later interruption, and its descriptor lease. */
const readFailure = (cause: unknown, read: MappingRead): AnalysisError => {
  const primary = readFailurePrimary(cause, read);
  if (
    read.signal.aborted &&
    !(primary instanceof AnalysisCancelledError) &&
    !(primary instanceof AnalysisTimeoutError)
  )
    primary.retainSecondaryFailure(
      mappingInterruption(read, read.signal.reason),
    );
  return projectStableArtifactFailure(
    cause,
    primary,
    read.path,
    "jadx",
    read.operation,
  );
};

/**
 * Read and parse one caller-selected R8/ProGuard mapping as a bounded,
 * identity-checked regular file. Failed descriptor cleanup stays owned by the
 * caller's resource scope.
 */
export const readAndroidMapping = async (
  path: string,
  operation: string,
  resources: ArtifactResourceScope,
  signal: AbortSignal,
  cached?: AndroidMappingSource,
  deadline?: AndroidMappingReadDeadline,
): Promise<Result<AndroidMappingSource, AnalysisError>> => {
  const read = { path, operation, signal, deadline };
  let snapshot: Awaited<ReturnType<typeof readStableArtifact>>;
  try {
    snapshot = await resources.run(() =>
      readStableArtifact(
        path,
        ANDROID_MAPPING_LIMITS.fileBytes,
        signal,
        undefined,
        resources,
      ),
    );
  } catch (cause: unknown) {
    return err(readFailure(cause, read));
  }
  const file = { path, sha256: snapshot.sha256, bytes: snapshot.bytes.length };
  // Only parsed facts are reused. The selected regular file is re-read and
  // identity-checked on every call; path/identity metadata always comes from it.
  // Parser options are fixed for this provider lifetime, independent of APKs.
  if (cached?.file.sha256 === file.sha256 && cached.file.bytes === file.bytes)
    return ok({ file, mapping: cached.mapping });
  const malformed = (message: string) =>
    err(
      invalidMapping(read, "invalid_format", message, {
        diagnostics: { mapping_sha256: snapshot.sha256 },
      }),
    );
  let text: string;
  try {
    // A mapping file saved by an editor may start with a BOM signature.
    text = decodeStrictUtf8(snapshot.bytes, "strip-signature");
  } catch {
    return malformed(`Mapping file is not valid UTF-8: ${path}`);
  }
  const mapping = parseProguardMapping(text, ANDROID_MAPPING_LIMITS);
  if (!mapping.ok) {
    if (mapping.error.kind === "capacity") {
      const { cause, line } = mapping.error;
      const { detail, limit } = cause.failure;
      return err(
        new AnalysisResourceConstraintError(
          operation,
          limit.name === "projection" ? "transport" : "memory",
          detail,
          { limit_bytes: limit.maximum, line },
          {
            cause,
            retryable: false,
            diagnostics: { mapping_path: path, mapping_sha256: file.sha256 },
            remediationAction:
              "Select a smaller mapping index or a mapping with a smaller per-class projection.",
          },
        ),
      );
    }
    return malformed(`Mapping file has no R8/ProGuard class records: ${path}`);
  }
  return ok({ file, mapping: mapping.value });
};
