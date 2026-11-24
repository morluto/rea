import { BinaryReader } from "./binaryContainer.js";
import { DEFAULT_ANDROID_SPARSE_READER_LIMITS } from "./artifactReaderLimits.js";
import {
  decodeLimit,
  malformedInput,
  truncatedInput,
  unsupportedInput,
} from "./parseFailure.js";
import type {
  AndroidSparseChunkDescriptor,
  AndroidSparseChunkMetadata,
  AndroidSparseChunkTypeName,
  AndroidSparseImageMetadata,
} from "./formatMetadata/androidAndSystemMetadata.js";

/** AOSP `system/core/libsparse/sparse_format.h` constants and bounds. */
export const ANDROID_SPARSE_FORMAT = "android-sparse-image" as const;
export const ANDROID_SPARSE_MAGIC = 0xed26ff3a;
export const ANDROID_SPARSE_MAJOR_VERSION = 1;
export const ANDROID_SPARSE_HEADER_SIZE = 28;
export const ANDROID_SPARSE_CHUNK_HEADER_SIZE = 12;

export const ANDROID_SPARSE_CHUNK_TYPE_RAW = 0xcac1;
export const ANDROID_SPARSE_CHUNK_TYPE_FILL = 0xcac2;
export const ANDROID_SPARSE_CHUNK_TYPE_DONT_CARE = 0xcac3;
export const ANDROID_SPARSE_CHUNK_TYPE_CRC32 = 0xcac4;

export const ANDROID_SPARSE_MAX_METADATA_CHUNKS = 256;
export const ANDROID_SPARSE_MAX_METADATA_CRC32_VALUES = 64;

const MAX_UINT32 = 0xffff_ffffn;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Adjustable chunk-count limit specification shared with `artifact_limits.android_sparse.chunk_count`. */
export const ANDROID_SPARSE_CHUNK_COUNT_LIMIT = {
  name: "Android sparse chunk count",
  parameter: "artifact_limits.android_sparse.chunk_count",
  unit: "count" as const,
} as const;

/** Parsed fields from the 28-byte LE `sparse_header_t`. */
export interface AndroidSparseHeader {
  readonly magic: typeof ANDROID_SPARSE_MAGIC;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly fileHdrSz: number;
  readonly chunkHdrSz: number;
  readonly blkSz: number;
  readonly totalBlks: number;
  readonly totalChunks: number;
  readonly imageChecksum: number;
  readonly unsparsedSize: number;
}

/** Validated positional plan for one `RAW` chunk entry. */
export interface AndroidSparseRawChunkEntryPlan {
  readonly path: string;
  readonly byteOffset: number;
  readonly declaredSize: number;
  readonly chunkIndex: number;
  readonly metadata: AndroidSparseChunkMetadata;
}

/** Validated structure of a parsed `chunk_header_t` prior to reading fill/crc32 payload word. */
export interface ParsedAndroidSparseChunkHeader {
  readonly index: number;
  readonly chunkType:
    | typeof ANDROID_SPARSE_CHUNK_TYPE_RAW
    | typeof ANDROID_SPARSE_CHUNK_TYPE_FILL
    | typeof ANDROID_SPARSE_CHUNK_TYPE_DONT_CARE
    | typeof ANDROID_SPARSE_CHUNK_TYPE_CRC32;
  readonly chunkTypeName: AndroidSparseChunkTypeName;
  readonly reserved: number;
  readonly chunkSz: number;
  readonly totalSz: number;
  readonly fileOffset: number;
  readonly dataOffset: number;
  readonly payloadBytes: number;
  readonly outputBlockOffset: number;
  readonly outputByteOffset: number;
  readonly outputBytes: number;
  readonly nextAccumulatedBlocks: bigint;
  readonly chunkEnd: number;
  readonly needsWordPayload: boolean;
}

/** Complete bounded output from walking all chunks of an Android sparse image. */
export interface AndroidSparseInspection {
  readonly header: AndroidSparseHeader;
  readonly metadata: AndroidSparseImageMetadata;
  readonly rawEntries: readonly AndroidSparseRawChunkEntryPlan[];
  readonly limitations: readonly string[];
  readonly complete: boolean;
}

const toBufferView = (bytes: Uint8Array): Buffer =>
  Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** True when `prefix` begins with the 4-byte LE Android sparse magic (`0xed26ff3a`). */
export const hasAndroidSparseImageMagic = (prefix: Uint8Array): boolean =>
  prefix.length >= 4 &&
  (prefix[0]! | (prefix[1]! << 8) | (prefix[2]! << 16) | (prefix[3]! << 24)) >>>
    0 ===
    ANDROID_SPARSE_MAGIC;

const chunkTypeNameFor = (
  chunkType: number,
  chunkIndex: number,
  fileOffset: number,
): {
  readonly chunkType: ParsedAndroidSparseChunkHeader["chunkType"];
  readonly name: AndroidSparseChunkTypeName;
} => {
  switch (chunkType) {
    case ANDROID_SPARSE_CHUNK_TYPE_RAW:
      return { chunkType, name: "raw" };
    case ANDROID_SPARSE_CHUNK_TYPE_FILL:
      return { chunkType, name: "fill" };
    case ANDROID_SPARSE_CHUNK_TYPE_DONT_CARE:
      return { chunkType, name: "dont_care" };
    case ANDROID_SPARSE_CHUNK_TYPE_CRC32:
      return { chunkType, name: "crc32" };
    default:
      throw malformedInput(
        ANDROID_SPARSE_FORMAT,
        `unknown sparse chunk_type 0x${chunkType.toString(16)} at chunk ${String(chunkIndex)}`,
        { offset: fileOffset, field: "chunk_type" },
      );
  }
};

/**
 * Parses and validates the 28-byte LE `sparse_header_t`.
 * Enforces intrinsic `uint16`/`fileSize` header bounds, block-size alignment,
 * `uint32`/safe-integer output sizing, minimum physical chunk-table extent, and
 * the adjustable `chunkCountLimit` (`artifact_limits.android_sparse.chunk_count`).
 */
export const parseAndroidSparseHeader = (
  headerBytes: Uint8Array,
  fileSize: number,
  chunkCountLimit: number = DEFAULT_ANDROID_SPARSE_READER_LIMITS.chunk_count,
): AndroidSparseHeader => {
  const availableHeader = Math.min(headerBytes.length, fileSize);
  if (availableHeader < ANDROID_SPARSE_HEADER_SIZE) {
    throw truncatedInput(
      ANDROID_SPARSE_FORMAT,
      `sparse image header is truncated (${String(availableHeader)} bytes, need ${String(ANDROID_SPARSE_HEADER_SIZE)})`,
      {
        offset: 0,
        field: "sparse_header",
        extent: {
          availableBytes: availableHeader,
          requiredBytes: ANDROID_SPARSE_HEADER_SIZE,
        },
      },
    );
  }
  const reader = new BinaryReader(
    toBufferView(headerBytes.subarray(0, ANDROID_SPARSE_HEADER_SIZE)),
    true,
    ANDROID_SPARSE_FORMAT,
  );
  const magic = reader.u32(0);
  if (magic !== ANDROID_SPARSE_MAGIC) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `sparse magic mismatch: expected 0x${ANDROID_SPARSE_MAGIC.toString(16)}, found 0x${magic.toString(16)}`,
      { offset: 0, field: "magic" },
    );
  }
  const majorVersion = reader.u16(4);
  if (majorVersion !== ANDROID_SPARSE_MAJOR_VERSION) {
    throw unsupportedInput(
      ANDROID_SPARSE_FORMAT,
      `unsupported sparse major_version ${String(majorVersion)} (expected ${String(ANDROID_SPARSE_MAJOR_VERSION)})`,
      { offset: 4, field: "major_version" },
    );
  }
  const minorVersion = reader.u16(6);
  const fileHdrSz = reader.u16(8);
  if (fileHdrSz < ANDROID_SPARSE_HEADER_SIZE) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `sparse file_hdr_sz (${String(fileHdrSz)}) is smaller than ${String(ANDROID_SPARSE_HEADER_SIZE)} bytes`,
      { offset: 8, field: "file_hdr_sz" },
    );
  }
  if (fileHdrSz > fileSize) {
    throw truncatedInput(
      ANDROID_SPARSE_FORMAT,
      `sparse file_hdr_sz (${String(fileHdrSz)}) exceeds carrier size (${String(fileSize)})`,
      {
        offset: 0,
        field: "file_hdr_sz",
        extent: { availableBytes: fileSize, requiredBytes: fileHdrSz },
      },
    );
  }
  const chunkHdrSz = reader.u16(10);
  if (chunkHdrSz < ANDROID_SPARSE_CHUNK_HEADER_SIZE) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `sparse chunk_hdr_sz (${String(chunkHdrSz)}) is smaller than ${String(ANDROID_SPARSE_CHUNK_HEADER_SIZE)} bytes`,
      { offset: 10, field: "chunk_hdr_sz" },
    );
  }
  const blkSz = reader.u32(12);
  if (blkSz === 0 || blkSz % 4 !== 0) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `sparse blk_sz (${String(blkSz)}) must be a non-zero multiple of 4 bytes`,
      { offset: 12, field: "blk_sz" },
    );
  }
  const totalBlks = reader.u32(16);
  const totalChunks = reader.u32(20);
  const imageChecksum = reader.u32(24);
  const unsparsedSizeBig = BigInt(totalBlks) * BigInt(blkSz);
  if (unsparsedSizeBig > MAX_SAFE_BIGINT) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `sparse unsparsed byte size (${String(unsparsedSizeBig)}) exceeds safe integer range`,
      { offset: 16, field: "total_blks" },
    );
  }
  // Verify carrier size can hold at least total_chunks minimal chunk headers before charging chunk_count.
  const minRequiredFileBytesBig =
    BigInt(fileHdrSz) + BigInt(totalChunks) * BigInt(chunkHdrSz);
  if (minRequiredFileBytesBig > BigInt(fileSize)) {
    throw truncatedInput(
      ANDROID_SPARSE_FORMAT,
      `sparse total_chunks (${String(totalChunks)}) requires at least ${String(minRequiredFileBytesBig)} bytes, past carrier size (${String(fileSize)})`,
      {
        offset: 20,
        field: "total_chunks",
        ...(minRequiredFileBytesBig <= MAX_SAFE_BIGINT
          ? {
              extent: {
                availableBytes: fileSize,
                requiredBytes: Number(minRequiredFileBytesBig),
              },
            }
          : {}),
      },
    );
  }
  if (totalChunks > chunkCountLimit) {
    throw decodeLimit(
      ANDROID_SPARSE_FORMAT,
      `Android sparse image exceeds the ${ANDROID_SPARSE_CHUNK_COUNT_LIMIT.name} allowance of ${String(chunkCountLimit)} ${ANDROID_SPARSE_CHUNK_COUNT_LIMIT.unit}`,
      {
        name: ANDROID_SPARSE_CHUNK_COUNT_LIMIT.name,
        maximum: chunkCountLimit,
        required: totalChunks,
      },
      { offset: 20, field: "total_chunks" },
    );
  }
  return {
    magic: ANDROID_SPARSE_MAGIC,
    majorVersion,
    minorVersion,
    fileHdrSz,
    chunkHdrSz,
    blkSz,
    totalBlks,
    totalChunks,
    imageChecksum,
    unsparsedSize: Number(unsparsedSizeBig),
  };
};

/** Validates one 12-byte `chunk_header_t` and its file/output extents using exact BigInt arithmetic. */
export const parseAndroidSparseChunkHeader = (
  chunkBytes: Uint8Array,
  header: AndroidSparseHeader,
  context: {
    readonly index: number;
    readonly fileOffset: number;
    readonly fileSize: number;
    readonly accumulatedBlocks: bigint;
  },
): ParsedAndroidSparseChunkHeader => {
  const { index, fileOffset, fileSize, accumulatedBlocks } = context;
  const availableFromOffset = Math.max(0, fileSize - fileOffset);
  if (
    chunkBytes.length < ANDROID_SPARSE_CHUNK_HEADER_SIZE ||
    BigInt(fileOffset) + BigInt(header.chunkHdrSz) > BigInt(fileSize)
  ) {
    throw truncatedInput(
      ANDROID_SPARSE_FORMAT,
      `chunk ${String(index)} header at offset ${String(fileOffset)} is truncated`,
      {
        offset: fileOffset,
        field: "chunk_header",
        extent: {
          availableBytes: Math.min(chunkBytes.length, availableFromOffset),
          requiredBytes: header.chunkHdrSz,
        },
      },
    );
  }
  const reader = new BinaryReader(
    toBufferView(chunkBytes.subarray(0, ANDROID_SPARSE_CHUNK_HEADER_SIZE)),
    true,
    ANDROID_SPARSE_FORMAT,
  );
  const rawChunkType = reader.u16(0);
  const reserved = reader.u16(2);
  const chunkSz = reader.u32(4);
  const totalSz = reader.u32(8);

  const recognizedType = chunkTypeNameFor(rawChunkType, index, fileOffset);
  if (totalSz < header.chunkHdrSz) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `chunk ${String(index)} total_sz (${String(totalSz)}) is smaller than chunk_hdr_sz (${String(header.chunkHdrSz)})`,
      { offset: fileOffset + 8, field: "total_sz" },
    );
  }

  const chunkHdrBig = BigInt(header.chunkHdrSz);
  const totalSzBig = BigInt(totalSz);
  const payloadBytesBig = totalSzBig - chunkHdrBig;
  const chunkBlocksBig = BigInt(chunkSz);
  const blkSzBig = BigInt(header.blkSz);
  const outputBytesBig = chunkBlocksBig * blkSzBig;

  if (outputBytesBig > MAX_SAFE_BIGINT) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `chunk ${String(index)} virtual output size exceeds safe integer range`,
      { offset: fileOffset + 4, field: "chunk_sz" },
    );
  }

  if (recognizedType.name === "raw") {
    if (payloadBytesBig !== outputBytesBig) {
      throw malformedInput(
        ANDROID_SPARSE_FORMAT,
        `RAW chunk ${String(index)} payload bytes (${String(payloadBytesBig)}) do not match chunk_sz * blk_sz (${String(outputBytesBig)})`,
        { offset: fileOffset + 8, field: "total_sz" },
      );
    }
  } else if (recognizedType.name === "fill") {
    if (payloadBytesBig !== 4n) {
      throw malformedInput(
        ANDROID_SPARSE_FORMAT,
        `FILL chunk ${String(index)} payload bytes (${String(payloadBytesBig)}) must equal 4`,
        { offset: fileOffset + 8, field: "total_sz" },
      );
    }
  } else if (recognizedType.name === "dont_care") {
    if (payloadBytesBig !== 0n) {
      throw malformedInput(
        ANDROID_SPARSE_FORMAT,
        `DONT_CARE chunk ${String(index)} payload bytes (${String(payloadBytesBig)}) must equal 0`,
        { offset: fileOffset + 8, field: "total_sz" },
      );
    }
  } else {
    if (chunkSz !== 0) {
      throw malformedInput(
        ANDROID_SPARSE_FORMAT,
        `CRC32 chunk ${String(index)} must declare chunk_sz 0 (found ${String(chunkSz)})`,
        { offset: fileOffset + 4, field: "chunk_sz" },
      );
    }
    if (payloadBytesBig !== 4n) {
      throw malformedInput(
        ANDROID_SPARSE_FORMAT,
        `CRC32 chunk ${String(index)} payload bytes (${String(payloadBytesBig)}) must equal 4`,
        { offset: fileOffset + 8, field: "total_sz" },
      );
    }
  }

  const nextAccumulatedBlocks = accumulatedBlocks + chunkBlocksBig;
  if (nextAccumulatedBlocks > MAX_UINT32) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `accumulated chunk block count overflows uint32 at chunk ${String(index)}`,
      { offset: fileOffset + 4, field: "chunk_sz" },
    );
  }
  if (nextAccumulatedBlocks > BigInt(header.totalBlks)) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `accumulated chunk blocks (${String(nextAccumulatedBlocks)}) exceed header total_blks (${String(header.totalBlks)}) at chunk ${String(index)}`,
      { offset: fileOffset + 4, field: "chunk_sz" },
    );
  }

  const chunkEndBig = BigInt(fileOffset) + totalSzBig;
  if (chunkEndBig > MAX_SAFE_BIGINT) {
    throw malformedInput(
      ANDROID_SPARSE_FORMAT,
      `chunk ${String(index)} carrier extent exceeds safe integer range`,
      { offset: fileOffset + 8, field: "total_sz" },
    );
  }
  const chunkEnd = Number(chunkEndBig);
  if (chunkEnd > fileSize) {
    throw truncatedInput(
      ANDROID_SPARSE_FORMAT,
      `chunk ${String(index)} (${recognizedType.name}) extends to byte ${String(chunkEnd)}, past carrier size (${String(fileSize)})`,
      {
        offset: fileOffset,
        field: "chunk_payload",
        extent: { availableBytes: availableFromOffset, requiredBytes: totalSz },
      },
    );
  }

  const dataOffsetBig = BigInt(fileOffset) + chunkHdrBig;
  const outputByteOffsetBig = accumulatedBlocks * blkSzBig;

  return {
    index,
    chunkType: recognizedType.chunkType,
    chunkTypeName: recognizedType.name,
    reserved,
    chunkSz,
    totalSz,
    fileOffset,
    dataOffset: Number(dataOffsetBig),
    payloadBytes: Number(payloadBytesBig),
    outputBlockOffset: Number(accumulatedBlocks),
    outputByteOffset: Number(outputByteOffsetBig),
    outputBytes: Number(outputBytesBig),
    nextAccumulatedBlocks,
    chunkEnd,
    needsWordPayload:
      recognizedType.name === "fill" || recognizedType.name === "crc32",
  };
};

/** Accumulates chunk summaries, counts, and bounded `RAW` positional entries without materializing virtual blocks. */
export class AndroidSparseWalkAccumulator {
  readonly #header: AndroidSparseHeader;
  readonly #fileSize: number;
  readonly #indexWidth: number;
  readonly #rawEntries: AndroidSparseRawChunkEntryPlan[] = [];
  readonly #chunks: AndroidSparseChunkDescriptor[] = [];
  readonly #crc32Values: number[] = [];

  #accumulatedBlocks = 0n;
  #parsedBytes: number;
  #rawChunkCount = 0;
  #fillChunkCount = 0;
  #dontCareChunkCount = 0;
  #crc32ChunkCount = 0;
  #rawBlocks = 0n;
  #fillBlocks = 0n;
  #dontCareBlocks = 0n;
  #rawDataBytes = 0n;
  #virtualFillBytes = 0n;
  #virtualDontCareBytes = 0n;
  #crc32ValuesOmitted = 0;
  #chunksOmitted = 0;

  constructor(header: AndroidSparseHeader, fileSize: number) {
    this.#header = header;
    this.#fileSize = fileSize;
    this.#parsedBytes = header.fileHdrSz;
    this.#indexWidth = Math.max(
      4,
      String(Math.max(header.totalChunks - 1, 0)).length,
    );
  }

  get accumulatedBlocks(): bigint {
    return this.#accumulatedBlocks;
  }

  get currentOffset(): number {
    return this.#parsedBytes;
  }

  /** Records one validated chunk along with its optional 4-byte LE `FILL` or `CRC32` word. */
  recordChunk(
    chunk: ParsedAndroidSparseChunkHeader,
    wordValue: number | null,
  ): void {
    this.#accumulatedBlocks = chunk.nextAccumulatedBlocks;
    this.#parsedBytes = chunk.chunkEnd;

    let fillPattern: number | null = null;
    let crc32Value: number | null = null;
    let entryPath: string | null = null;

    if (chunk.chunkTypeName === "raw") {
      this.#rawChunkCount += 1;
      this.#rawBlocks += BigInt(chunk.chunkSz);
      this.#rawDataBytes += BigInt(chunk.outputBytes);
      entryPath = `chunks/chunk-${String(chunk.index).padStart(this.#indexWidth, "0")}-raw.bin`;
      this.#rawEntries.push({
        path: entryPath,
        byteOffset: chunk.dataOffset,
        declaredSize: chunk.outputBytes,
        chunkIndex: chunk.index,
        metadata: {
          kind: "android-sparse-chunk",
          chunk_index: chunk.index,
          chunk_type: ANDROID_SPARSE_CHUNK_TYPE_RAW,
          chunk_type_name: "raw",
          reserved: chunk.reserved,
          file_offset: chunk.fileOffset,
          data_offset: chunk.dataOffset,
          total_size: chunk.totalSz,
          output_block_offset: chunk.outputBlockOffset,
          output_byte_offset: chunk.outputByteOffset,
          output_blocks: chunk.chunkSz,
          output_bytes: chunk.outputBytes,
        },
      });
    } else if (chunk.chunkTypeName === "fill") {
      this.#fillChunkCount += 1;
      this.#fillBlocks += BigInt(chunk.chunkSz);
      this.#virtualFillBytes += BigInt(chunk.outputBytes);
      fillPattern = wordValue;
    } else if (chunk.chunkTypeName === "dont_care") {
      this.#dontCareChunkCount += 1;
      this.#dontCareBlocks += BigInt(chunk.chunkSz);
      this.#virtualDontCareBytes += BigInt(chunk.outputBytes);
    } else {
      this.#crc32ChunkCount += 1;
      crc32Value = wordValue;
      if (wordValue !== null) {
        if (
          this.#crc32Values.length < ANDROID_SPARSE_MAX_METADATA_CRC32_VALUES
        ) {
          this.#crc32Values.push(wordValue);
        } else {
          this.#crc32ValuesOmitted += 1;
        }
      }
    }

    if (this.#chunks.length < ANDROID_SPARSE_MAX_METADATA_CHUNKS) {
      this.#chunks.push({
        chunk_index: chunk.index,
        chunk_type: chunk.chunkType,
        chunk_type_name: chunk.chunkTypeName,
        reserved: chunk.reserved,
        chunk_blocks: chunk.chunkSz,
        total_size: chunk.totalSz,
        file_offset: chunk.fileOffset,
        data_offset: chunk.dataOffset,
        payload_bytes: chunk.payloadBytes,
        output_block_offset: chunk.outputBlockOffset,
        output_byte_offset: chunk.outputByteOffset,
        output_bytes: chunk.outputBytes,
        fill_pattern: fillPattern,
        crc32: crc32Value,
        entry_path: entryPath,
      });
    } else {
      this.#chunksOmitted += 1;
    }
  }

  /** Verifies end-of-walk `total_blks` consistency and produces bounded metadata, raw entries, and limitations. */
  finalize(): AndroidSparseInspection {
    if (this.#accumulatedBlocks !== BigInt(this.#header.totalBlks)) {
      throw malformedInput(
        ANDROID_SPARSE_FORMAT,
        `sparse chunk block sum (${String(this.#accumulatedBlocks)}) does not match header total_blks (${String(this.#header.totalBlks)})`,
        { offset: this.#header.fileHdrSz, field: "total_blks" },
      );
    }

    const trailingBytes = Math.max(0, this.#fileSize - this.#parsedBytes);
    const limitations: string[] = [];

    if (this.#fillChunkCount > 0 || this.#dontCareChunkCount > 0) {
      limitations.push(
        "Virtual FILL (0xCAC2) and DONT_CARE (0xCAC3) chunks are summarized in metadata without materializing unsparsed output blocks.",
      );
    }
    limitations.push(
      "Sparse header image_checksum and CRC32 (0xCAC4) chunk values are recorded without recomputing checksums across virtual output blocks.",
    );
    if (this.#chunksOmitted > 0) {
      limitations.push(
        `Inline chunks list retains the first ${String(ANDROID_SPARSE_MAX_METADATA_CHUNKS)} chunk descriptors (${String(this.#chunksOmitted)} additional chunks summarized in aggregate totals).`,
      );
    }
    if (trailingBytes > 0) {
      limitations.push(
        `${String(trailingBytes)} trailing byte(s) after chunk ${String(this.#header.totalChunks)} were not parsed.`,
      );
    }

    const metadata: AndroidSparseImageMetadata = {
      kind: "android-sparse-image",
      magic: this.#header.magic,
      major_version: this.#header.majorVersion,
      minor_version: this.#header.minorVersion,
      file_header_size: this.#header.fileHdrSz,
      chunk_header_size: this.#header.chunkHdrSz,
      block_size: this.#header.blkSz,
      total_blocks: this.#header.totalBlks,
      total_chunks: this.#header.totalChunks,
      image_checksum: this.#header.imageChecksum,
      unsparsed_size: this.#header.unsparsedSize,
      file_size: this.#fileSize,
      parsed_bytes: this.#parsedBytes,
      trailing_bytes: trailingBytes,
      raw_chunk_count: this.#rawChunkCount,
      fill_chunk_count: this.#fillChunkCount,
      dont_care_chunk_count: this.#dontCareChunkCount,
      crc32_chunk_count: this.#crc32ChunkCount,
      raw_blocks: Number(this.#rawBlocks),
      fill_blocks: Number(this.#fillBlocks),
      dont_care_blocks: Number(this.#dontCareBlocks),
      raw_data_bytes: Number(this.#rawDataBytes),
      virtual_fill_bytes: Number(this.#virtualFillBytes),
      virtual_dont_care_bytes: Number(this.#virtualDontCareBytes),
      crc32_verified: false,
      crc32_chunk_values: this.#crc32Values,
      crc32_chunk_values_omitted: this.#crc32ValuesOmitted,
      chunks: this.#chunks,
      chunks_omitted: this.#chunksOmitted,
    };

    return {
      header: this.#header,
      metadata,
      rawEntries: this.#rawEntries,
      limitations,
      complete: trailingBytes === 0,
    };
  }
}

/** Reads a 4-byte little-endian unsigned word at `offset` inside `bytes`. */
export const readUint32LE = (bytes: Uint8Array, offset: number): number =>
  new BinaryReader(
    toBufferView(bytes.subarray(offset, offset + 4)),
    true,
    ANDROID_SPARSE_FORMAT,
  ).u32(0);

/**
 * Pure in-memory static parser for unit tests and bounded preflight inspection.
 * Never allocates virtual zero/fill blocks.
 */
export const inspectAndroidSparseBuffer = (
  bytes: Uint8Array,
  options?: { readonly chunkCountLimit?: number },
): AndroidSparseInspection => {
  const header = parseAndroidSparseHeader(
    bytes,
    bytes.length,
    options?.chunkCountLimit,
  );
  const accumulator = new AndroidSparseWalkAccumulator(header, bytes.length);
  let offset = header.fileHdrSz;
  for (let index = 0; index < header.totalChunks; index += 1) {
    const chunk = parseAndroidSparseChunkHeader(
      bytes.subarray(
        offset,
        Math.min(bytes.length, offset + ANDROID_SPARSE_CHUNK_HEADER_SIZE),
      ),
      header,
      {
        index,
        fileOffset: offset,
        fileSize: bytes.length,
        accumulatedBlocks: accumulator.accumulatedBlocks,
      },
    );
    const wordValue = chunk.needsWordPayload
      ? readUint32LE(bytes, chunk.dataOffset)
      : null;
    accumulator.recordChunk(chunk, wordValue);
    offset = chunk.chunkEnd;
  }
  return accumulator.finalize();
};
