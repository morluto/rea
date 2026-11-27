import { nodeCodecResult } from "../kernel/nodeCodecResult.js";
import { inflate } from "node:zlib";
import { scheduler } from "node:timers/promises";
import { promisify } from "node:util";
import { assertArtifactReadActive } from "../resources/index.js";
import { decodeLz4Block } from "../compression/Lz4Block.js";
import {
  decodeZstandardFramesCooperative,
  isZstandardTruncationReason,
  ZSTANDARD_WINDOW_LOG_MAX,
} from "../domain/compression/zstandardExactFrame.js";
import {
  ZstandardFrameAllowanceError,
  type ZstandardFrameAllowance,
} from "../domain/compression/zstandardFrameAllowance.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";
import {
  DEFAULT_GPU_OBJECT_BYTES,
  GPU_OBJECT_BYTES_LIMIT,
} from "../domain/gpu/gpuCodeObjectsBudgets.js";
import { rejectGpu } from "./GpuSource.js";
const unzip = promisify(inflate);

/** Codec-owned marker for a stream that ran out of input bytes rather than corrupting or overflowing. */
class GpuTruncatedPayloadFailure extends BinaryFormatFailure {
  constructor(
    message: string,
    context?: {
      readonly format?: string;
      readonly field?: string;
      readonly offset?: number;
    },
  ) {
    super("malformed", message, context);
  }
}

/** True when a GPU codec failure indicates truncated compressed input rather than corrupt bytes or output overflow. */
export const isTruncatedGpuPayloadFailure = (
  error: unknown,
): error is BinaryFormatFailure => error instanceof GpuTruncatedPayloadFailure;
/** Completed codec bytes, their encoded extent, and whether input ended where another frame could still continue. */
export const decodeGpuPayloadStream = async (
  bytes: Buffer,
  compression: "zlib" | "zstd",
  maximumDecodedSize: number,
  signal?: AbortSignal,
): Promise<{
  buffer: Buffer;
  consumedBytes: number;
  inputExhausted: boolean;
  frameAllowanceReached?: ZstandardFrameAllowance;
}> => {
  assertArtifactReadActive(signal);
  const maxOutputLength = Math.max(1, maximumDecodedSize);
  if (compression === "zstd") {
    const decoded = await decodeZstandardFramesCooperative(
      bytes,
      {
        maxOutputLength,
        windowLogMax: ZSTANDARD_WINDOW_LOG_MAX,
        mode: "prefix",
      },
      async () => {
        await scheduler.yield();
        assertArtifactReadActive(signal);
      },
    );
    assertArtifactReadActive(signal);
    if (!decoded.ok) {
      if (
        decoded.reason === "invalid_allowance" &&
        decoded.configuration !== undefined
      )
        throw decoded.configuration;
      if (decoded.reason === "work_limit")
        throw new ZstandardFrameAllowanceError(
          {
            maxFrames: decoded.value ?? 0,
            source: decoded.source ?? "default",
          },
          decoded.offset,
        );
      if (isZstandardTruncationReason(decoded.reason))
        throw new GpuTruncatedPayloadFailure(
          "GPU payload decompression failed or exceeded its declared length",
          {
            format: "zstd",
            field: decoded.reason,
            offset: decoded.offset,
          },
        );
      throw new BinaryFormatFailure(
        "malformed",
        "GPU payload decompression failed or exceeded its declared length",
        {
          format: "zstd",
          field: decoded.reason,
          offset: decoded.offset,
        },
      );
    }
    return {
      buffer: decoded.bytes,
      consumedBytes: decoded.consumedBytes,
      inputExhausted: decoded.inputExhausted,
      ...(decoded.frameAllowanceReached === undefined
        ? {}
        : { frameAllowanceReached: decoded.frameAllowanceReached }),
    };
  }
  let result: unknown;
  try {
    result = await unzip(bytes, { maxOutputLength, info: true });
  } catch (cause: unknown) {
    assertArtifactReadActive(signal);
    const code =
      cause instanceof Error && "code" in cause
        ? String(cause.code)
        : undefined;
    if (code === "Z_BUF_ERROR")
      throw new GpuTruncatedPayloadFailure(
        "GPU payload decompression failed or exceeded its declared length",
        { format: "zlib", field: code },
      );
    return rejectGpu(
      "GPU payload decompression failed or exceeded its declared length",
    );
  }
  assertArtifactReadActive(signal);
  const { buffer: decoded, consumedBytes: consumed } = nodeCodecResult(result);
  if (
    !Number.isSafeInteger(consumed) ||
    consumed <= 0 ||
    consumed > bytes.length
  )
    rejectGpu("GPU decoder returned an invalid complete codec extent");
  return { buffer: decoded, consumedBytes: consumed, inputExhausted: false };
};
export const decodeGpuPayload = async (
  bytes: Buffer,
  compression: "zlib" | "zstd" | "lz4",
  expected: number,
  signal?: AbortSignal,
  maxObjectBytes: number = DEFAULT_GPU_OBJECT_BYTES,
): Promise<Buffer> => {
  assertArtifactReadActive(signal);
  if (expected > maxObjectBytes)
    throw new BinaryResourceFailure(
      "structure",
      maxObjectBytes,
      `GPU payload decoded length exceeds the ${String(maxObjectBytes)}-byte object budget`,
      GPU_OBJECT_BYTES_LIMIT,
      "bytes",
    );
  if (compression === "lz4") {
    try {
      return await decodeLz4Block(bytes, expected, maxObjectBytes, signal);
    } catch (cause) {
      if (cause instanceof BinaryResourceFailure)
        throw new BinaryResourceFailure(
          "structure",
          maxObjectBytes,
          cause.message,
          GPU_OBJECT_BYTES_LIMIT,
          "bytes",
        );
      throw cause;
    }
  }
  const decoded = await decodeGpuPayloadStream(
    bytes,
    compression,
    expected,
    signal,
  );
  if (decoded.consumedBytes !== bytes.length)
    rejectGpu(
      "GPU compressed payload contains bytes outside its complete codec stream",
    );
  if (decoded.buffer.length !== expected)
    rejectGpu("GPU decompressed length disagrees with its declaration");
  return decoded.buffer;
};
