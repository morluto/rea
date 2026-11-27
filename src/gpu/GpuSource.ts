import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  assertArtifactReadActive,
  ArtifactReaderFailure,
  yieldArtifactRead,
} from "../resources/index.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
  NATIVE_STRUCTURE_LIMIT,
} from "../domain/binaryContainer.js";
import { decodeElfSectionNameRequestCooperative } from "../domain/native/elfSectionNameTable.js";
import type { ZstandardFramePause } from "../domain/compression/zstandardExactFrame.js";
import { NATIVE_STRUCTURE_BYTES } from "../domain/native/nativeStructureBudget.js";
import type {
  NativeReadRequest,
  NativeSectionDirectory,
} from "../domain/native/nativeSectionDirectory.js";
import {
  DEFAULT_GPU_OBJECT_BYTES,
  DEFAULT_GPU_REPORT_BYTES,
  GPU_OBJECT_BYTES_LIMIT,
  GPU_RETAINED_REPORT_BYTES_LIMIT,
} from "../domain/gpu/gpuCodeObjectsBudgets.js";
/** A retained-facts refusal aborts discovery; it is never downgraded to one opaque payload. */
export class GpuReportCapacityFailure extends BinaryResourceFailure {
  /**
   * Lower bound measured up to the stopped step. Kept out of `limit.required`
   * because later facts may require more bytes to admit the complete request.
   */
  readonly minimumReportBytes?: number;

  constructor(
    maxReportBytes: number = DEFAULT_GPU_REPORT_BYTES,
    minimumReportBytes?: number,
  ) {
    super(
      "structure",
      maxReportBytes,
      `GPU facts exceed the ${String(maxReportBytes)}-byte retained report budget`,
      GPU_RETAINED_REPORT_BYTES_LIMIT,
      "bytes",
    );
    if (minimumReportBytes !== undefined)
      this.minimumReportBytes = minimumReportBytes;
  }
}
export const rejectGpu = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};
export const gpuCount = (value: bigint): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    rejectGpu("GPU range exceeds exact host offset precision");
  return Number(value);
};
export interface GpuSource {
  readonly size: number;
  readonly containerId: string | null;
  readonly maxObjectBytes?: number;
  read(offset: number, size: number): Promise<Buffer>;
  readBounded?(
    offset: number,
    size: number,
    maximumBytes: number,
    limitName?: string,
  ): Promise<Buffer>;
}
export const checkGpuRange = (
  length: number,
  offset: number,
  size: number,
  maxBytes: number = DEFAULT_GPU_OBJECT_BYTES,
  limitName: string = GPU_OBJECT_BYTES_LIMIT,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > length ||
    size > length - offset
  )
    rejectGpu("GPU byte range is outside its containing object");
  if (size > maxBytes)
    throw new BinaryResourceFailure(
      "structure",
      maxBytes,
      limitName === NATIVE_STRUCTURE_LIMIT
        ? `Native container structure read exceeds the ${String(maxBytes)}-byte structure budget`
        : `GPU object exceeds the ${String(maxBytes)}-byte decoding budget`,
      limitName,
      "bytes",
    );
};
export class GpuFileSource implements GpuSource {
  readonly containerId = null;
  bytesRead = 0;
  constructor(
    readonly file: FileHandle,
    readonly size: number,
    readonly signal?: AbortSignal,
    readonly maxObjectBytes: number = DEFAULT_GPU_OBJECT_BYTES,
  ) {}
  read(offset: number, size: number): Promise<Buffer> {
    return this.readBounded(
      offset,
      size,
      this.maxObjectBytes,
      GPU_OBJECT_BYTES_LIMIT,
    );
  }
  async readBounded(
    offset: number,
    size: number,
    maximumBytes: number,
    limitName: string = GPU_OBJECT_BYTES_LIMIT,
  ): Promise<Buffer> {
    checkGpuRange(this.size, offset, size, maximumBytes, limitName);
    const bytes = Buffer.alloc(size);
    let position = 0;
    while (position < size) {
      assertArtifactReadActive(this.signal);
      const result = await this.file.read(
        bytes,
        position,
        size - position,
        offset + position,
      );
      if (result.bytesRead === 0)
        throw new ArtifactReaderFailure(
          "integrity",
          "GPU source was truncated during inspection",
          { integrityCheck: "read-coverage" },
        );
      position += result.bytesRead;
      this.bytesRead += result.bytesRead;
    }
    return bytes;
  }
  async digest(): Promise<string> {
    // Full-file SHA-256 streams in fixed 1 MiB chunks independent of per-object maxObjectBytes.
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, this.size));
    for (let position = 0; position < this.size;) {
      assertArtifactReadActive(this.signal);
      const want = Math.min(chunk.length, this.size - position);
      const result = await this.file.read(chunk, 0, want, position);
      if (result.bytesRead === 0)
        throw new ArtifactReaderFailure(
          "integrity",
          "GPU source was truncated during inspection",
          { integrityCheck: "read-coverage" },
        );
      hash.update(chunk.subarray(0, result.bytesRead));
      position += result.bytesRead;
      this.bytesRead += result.bytesRead;
    }
    return hash.digest("hex");
  }
}
export class GpuBufferSource implements GpuSource {
  readonly size: number;
  constructor(
    readonly bytes: Buffer,
    readonly containerId: string | null,
    readonly maxObjectBytes: number = DEFAULT_GPU_OBJECT_BYTES,
  ) {
    this.size = bytes.length;
  }
  read(offset: number, size: number): Promise<Buffer> {
    return this.readBounded(
      offset,
      size,
      this.maxObjectBytes,
      GPU_OBJECT_BYTES_LIMIT,
    );
  }
  async readBounded(
    offset: number,
    size: number,
    maximumBytes: number,
    limitName: string = GPU_OBJECT_BYTES_LIMIT,
  ): Promise<Buffer> {
    checkGpuRange(this.size, offset, size, maximumBytes, limitName);
    return this.bytes.subarray(offset, offset + size);
  }
}
export const readGpuNativeDirectory = async (
  source: GpuSource,
  steps: Generator<NativeReadRequest, NativeSectionDirectory, Buffer>,
  pause: ZstandardFramePause,
  maxStructureBytes: number = NATIVE_STRUCTURE_BYTES.default_value,
): Promise<NativeSectionDirectory> => {
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (
      step.sectionNames !== undefined &&
      step.fulfillSectionNames !== undefined
    ) {
      step.fulfillSectionNames(
        await decodeElfSectionNameRequestCooperative(step.sectionNames, pause),
      );
      next = steps.next(Buffer.alloc(0));
      continue;
    }
    const chunk =
      source.readBounded !== undefined
        ? await source.readBounded(
            step.offset,
            step.size,
            maxStructureBytes,
            NATIVE_STRUCTURE_LIMIT,
          )
        : await source.read(step.offset, step.size);
    next = steps.next(chunk);
  }
  return next.value;
};
export const CONTAINER_SCAN_CHUNK_BYTES = 65_536;
export const nextGpuContainerOffset = async (
  source: GpuSource,
  start: number,
  signal?: AbortSignal,
): Promise<number> => {
  const maxChunk = Math.max(
    1,
    Math.min(
      CONTAINER_SCAN_CHUNK_BYTES,
      source.maxObjectBytes ?? DEFAULT_GPU_OBJECT_BYTES,
    ),
  );
  let width = Math.min(64, maxChunk);
  let scannedSinceYield = 0;
  for (let position = start; position < source.size;) {
    const chunk = Math.min(width, maxChunk, source.size - position);
    const bytes =
      source.readBounded !== undefined
        ? await source.readBounded(position, chunk, maxChunk)
        : await source.read(position, chunk);
    const index = bytes.findIndex((byte) => byte !== 0);
    if (index >= 0) return position + index;
    position += bytes.length;
    scannedSinceYield += bytes.length;
    if (scannedSinceYield >= 1024 * 1024) {
      scannedSinceYield = 0;
      await yieldArtifactRead(signal);
    }
    width = maxChunk;
  }
  return source.size;
};
