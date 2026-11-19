import { nodeCodecResult } from "../kernel/nodeCodecResult.js";
import { inflate } from "node:zlib";
import { promisify } from "node:util";
import { assertArtifactReadActive } from "../resources/index.js";
import { decodeLz4Block } from "../compression/Lz4Block.js";
import {
  decodeZstandardFrames,
  ZSTANDARD_WINDOW_LOG_MAX,
} from "../domain/compression/zstandardExactFrame.js";
import { ZstandardFrameAllowanceError } from "../domain/compression/zstandardFrameAllowance.js";
import { BinaryFormatFailure } from "../domain/binaryContainer.js";
import { GPU_OBJECT_BYTES, rejectGpu } from "./GpuSource.js";
const unzip = promisify(inflate);
/** Completed codec bytes and their encoded extent share one completion owner. */
export const decodeGpuPayloadStream = async (
  bytes: Buffer,
  compression: "zlib" | "zstd",
  maximumDecodedSize: number,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; consumedBytes: number }> => {
  assertArtifactReadActive(signal);
  const maxOutputLength = Math.max(1, maximumDecodedSize);
  if (compression === "zstd") {
    const decoded = decodeZstandardFrames(bytes, {
      maxOutputLength,
      windowLogMax: ZSTANDARD_WINDOW_LOG_MAX,
      mode: "prefix",
    });
    assertArtifactReadActive(signal);
    if (!decoded.ok) {
      if (decoded.reason === "work_limit")
        throw new ZstandardFrameAllowanceError(
          {
            maxFrames: decoded.value ?? 0,
            source: decoded.source ?? "default",
          },
          decoded.offset,
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
    return { buffer: decoded.bytes, consumedBytes: decoded.consumedBytes };
  }
  let result: unknown;
  try {
    result = await unzip(bytes, { maxOutputLength, info: true });
  } catch {
    assertArtifactReadActive(signal);
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
  return { buffer: decoded, consumedBytes: consumed };
};
export const decodeGpuPayload = async (
  bytes: Buffer,
  compression: "zlib" | "zstd" | "lz4",
  expected: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  assertArtifactReadActive(signal);
  if (compression === "lz4")
    return decodeLz4Block(bytes, expected, GPU_OBJECT_BYTES, signal);
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
