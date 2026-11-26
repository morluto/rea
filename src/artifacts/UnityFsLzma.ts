import { fileURLToPath } from "node:url";
import type { AnalysisErrorOptions } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { LZMA_WORKER_LIMITS } from "../domain/compression/lzmaWorkerLimits.js";
import type { LimitRef } from "../domain/parseFailure.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import {
  LzmaReplyFailure,
  LzmaSession,
  type LzmaFailurePolicy,
} from "../providers/LzmaSession.js";
import {
  processInspectionCancellationError,
  retainOwnedCommandCleanup,
} from "../providers/OwnedCommandCleanup.js";
import {
  AnalysisCleanupLease,
  ArtifactReaderFailure,
  type ArtifactResourceScope,
  assertArtifactReadActive,
  malformedArtifact,
} from "../resources/index.js";
import type { LzmaDecodeResult } from "../providers/LzmaProtocol.js";

const PROPERTIES_BYTES = 5;
const SIZE_BYTES = 8;
const RANGE_CODER_BYTES = 5;
const OPERATION = "decode_unityfs_block";
const PROVIDER_ID = "rea-unityfs";

export interface UnityFsDecodeContext {
  readonly resources: ArtifactResourceScope;
  readonly signal?: AbortSignal | undefined;
  readonly workerModulePath?: string | undefined;
}

const cancelled = (reason: unknown) =>
  new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
    cause: reason,
  });

const unavailableWorker = (detail: string, options: AnalysisErrorOptions) =>
  new AnalysisCapabilityUnavailableError(
    PROVIDER_ID,
    OPERATION,
    `UnityFS LZMA worker failed: ${detail}`,
    options,
  );

const workerFailureDialect: ProviderFailureDialect = {
  providerId: PROVIDER_ID,
  operation: OPERATION,
  recognise: (cause) => processInspectionCancellationError(cause, OPERATION),
  command: () => ({
    operation: OPERATION,
    capturedOutput: capturedProviderOutput,
    outputLimit: {
      limits: { diagnostic_bytes: LZMA_WORKER_LIMITS.diagnosticBytes },
      recovery: { retryable: false },
    },
    dialect: (outcome, options) => unavailableWorker(outcome.message, options),
  }),
  unclassified: (cause, options) =>
    unavailableWorker(errorMessage(cause), { ...options, cause }),
};

const classifyWorkerFailure = (
  cause: unknown,
  signal: AbortSignal,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (cause instanceof LzmaReplyFailure) return replyFailure(cause.reply);
  if (signal.aborted && Object.is(cause, signal.reason))
    return cancelled(signal.reason);
  const failure = classifyProviderFailure(cause, workerFailureDialect);
  if (failure instanceof AnalysisCancelledError)
    return cancelled(failure.cause);
  if (failure instanceof AnalysisResourceConstraintError)
    return new ArtifactReaderFailure("limit", failure.reason, {
      cause: failure,
      resourceConstraint: failure,
    });
  return new ArtifactReaderFailure(
    "unavailable",
    failure instanceof AnalysisCapabilityUnavailableError
      ? failure.reason
      : failure.message,
    { cause: failure },
  );
};

const failurePolicy = (
  resources: ArtifactResourceScope,
  signal: AbortSignal,
): LzmaFailurePolicy<ArtifactReaderFailure> => ({
  runtimePrefix: "rea-unityfs-lzma",
  classify: (cause) => classifyWorkerFailure(cause, signal),
  retainInspectionCleanup(preparation, primary) {
    const leases: AnalysisCleanupLease[] = [];
    const failures = retainOwnedCommandCleanup(
      preparation,
      {
        retain(owner, resource) {
          const lease = AnalysisCleanupLease.forCloseOwner(owner, resource);
          resources.retain({ kind: "lease", resource, lease });
          leases.push(lease);
        },
        run: (work) => work(),
      },
      PROVIDER_ID,
      OPERATION,
    );
    if (failures.length === 0) return primary;
    return ArtifactReaderFailure.withCleanup(
      primary,
      {
        reason: failures
          .map((failure) => failure.cleanup?.reason ?? failure.message)
          .join("; "),
        resources: [
          ...new Set(failures.flatMap((failure) => failure.cleanupResources)),
        ],
      },
      undefined,
      primary.cleanupLeases !== undefined && leases.length === failures.length
        ? [...primary.cleanupLeases, ...leases]
        : undefined,
    );
  },
  cleanupFailure(primary, released) {
    return resources.cleanupFailure(
      primary === undefined
        ? { kind: "completed" }
        : { kind: "failed", cause: primary },
      [released],
    );
  },
});

const limitFailure = (
  detail: string,
  parserLimit: LimitRef,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure("limit", detail, {
    boundary: "memory",
    parserLimit,
  });
const malformed = (detail: string): ArtifactReaderFailure =>
  malformedArtifact("unityfs", `UnityFS is malformed: ${detail}`, {
    field: "block",
  });

/** Convert the UnityFS raw layout to the same LZMA-Alone framing used by UEFI. */
const alonePayload = (
  encoded: Buffer,
  expected: number,
  maximumBytes: number,
): Buffer => {
  if (!Number.isSafeInteger(expected) || expected < 0)
    throw malformed("Invalid declared LZMA output length");
  const outputLimit = Math.min(maximumBytes, LZMA_WORKER_LIMITS.outputBytes);
  if (expected > outputLimit)
    throw limitFailure("UnityFS LZMA exceeds the decoder memory budget", {
      name: "output_bytes",
      maximum: outputLimit,
      required: expected,
    });
  if (encoded.length < PROPERTIES_BYTES + RANGE_CODER_BYTES)
    throw malformed("Incomplete raw LZMA header");
  if (encoded.length + SIZE_BYTES > LZMA_WORKER_LIMITS.inputBytes)
    throw limitFailure("UnityFS LZMA exceeds the framed decoder input budget", {
      name: "input_bytes",
      maximum: LZMA_WORKER_LIMITS.inputBytes,
      required: encoded.length + SIZE_BYTES,
    });
  const payload = Buffer.allocUnsafe(encoded.length + SIZE_BYTES);
  encoded.copy(payload, 0, 0, PROPERTIES_BYTES);
  payload.writeBigUInt64LE(BigInt(expected), PROPERTIES_BYTES);
  encoded.copy(payload, PROPERTIES_BYTES + SIZE_BYTES, PROPERTIES_BYTES);
  return payload;
};

const replyFailure = (
  result: Extract<LzmaDecodeResult, { readonly ok: false }>,
): ArtifactReaderFailure => {
  if (result.reason === "output-limit") {
    const limit = result.limit;
    if (limit === undefined)
      return new ArtifactReaderFailure(
        "unavailable",
        "LZMA worker omitted its limit observation",
      );
    return limitFailure(result.message, {
      name: limit.boundary,
      maximum: limit.maximum,
      ...(limit.required === undefined
        ? {}
        : {
            required:
              typeof limit.required === "string"
                ? BigInt(limit.required)
                : limit.required,
          }),
    });
  }
  if (result.reason === "malformed") return malformed(result.message);
  return new ArtifactReaderFailure(
    "unavailable",
    `UnityFS LZMA decoder failed: ${result.message}`,
  );
};

const decodedBlock = (result: LzmaDecodeResult, expected: number): Buffer => {
  if (!result.ok) throw replyFailure(result);
  if (result.outcome.bytes.length !== expected)
    throw malformed("LZMA output differs from its declared size");
  return result.outcome.bytes;
};

/** One session per concurrently admitted block; independent streams cannot interleave frames. */
export const decodeUnityFsLzma = async (
  encoded: Buffer,
  expected: number,
  maximumBytes: number,
  {
    resources,
    signal: callerSignal,
    workerModulePath = fileURLToPath(
      new URL("../providers/LzmaWorker.js", import.meta.url),
    ),
  }: UnityFsDecodeContext,
): Promise<Buffer> => {
  const signal = callerSignal ?? new AbortController().signal;
  assertArtifactReadActive(signal);
  const payload = alonePayload(encoded, expected, maximumBytes);
  const session = new LzmaSession(
    workerModulePath,
    resources,
    failurePolicy(resources, signal),
  );
  let bytes: Buffer;
  try {
    // The shared protocol requires a positive sink bound. The declared size
    // and final equality check still enforce an exact zero-byte result.
    bytes = decodedBlock(
      await session.decode(payload, "lzma", Math.max(1, expected), signal),
      expected,
    );
    assertArtifactReadActive(signal);
  } catch (cause: unknown) {
    const primary = classifyWorkerFailure(cause, signal);
    await session.close(primary);
    throw primary;
  }
  try {
    await session.close();
  } catch (cause: unknown) {
    // Cancellation may arrive while the successful reply's worker is closing.
    // Do not replace a concurrent cleanup failure with a bare cancellation.
    if (
      signal.aborted &&
      cause instanceof ArtifactReaderFailure &&
      cause.cleanup !== undefined
    )
      throw ArtifactReaderFailure.withCleanup(
        cancelled(signal.reason),
        cause.cleanup,
        cause.partialObservation,
        cause.cleanupLeases,
      );
    throw cause;
  }
  assertArtifactReadActive(signal);
  return bytes;
};
