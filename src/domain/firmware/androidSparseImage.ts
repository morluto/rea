import {
  decodeLimit,
  malformedInput,
  truncatedInput,
  unsupportedInput,
  type ParseFailureError,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import { BinaryReader } from "../binaryContainer.js";

/** Little-endian magic `0xED26FF3A` from AOSP `sparse_format.h`. */
export const ANDROID_SPARSE_MAGIC = 0xed26ff3a;
export const ANDROID_SPARSE_MAJOR_VERSION = 1;
export const ANDROID_SPARSE_FILE_HEADER_BYTES = 28;
export const ANDROID_SPARSE_CHUNK_HEADER_BYTES = 12;
/** FILL patterns and CRC32 values retained in metadata. */
export const ANDROID_SPARSE_LISTED_CHUNKS = 16;
const UNDECODED_HEX_BYTES = 64;

export const ANDROID_SPARSE_CHUNK_RAW = 0xcac1;
export const ANDROID_SPARSE_CHUNK_FILL = 0xcac2;
export const ANDROID_SPARSE_CHUNK_DONT_CARE = 0xcac3;
export const ANDROID_SPARSE_CHUNK_CRC32 = 0xcac4;

const EXPANDED_LIMIT = {
  name: "Android sparse expanded image",
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

/** Parser-owned fixed ceilings and their units for artifact recovery. */
export const ANDROID_SPARSE_FIXED_LIMITS: ReadonlyMap<
  string,
  { readonly name: string; readonly unit: string }
> = new Map([[EXPANDED_LIMIT.name, { ...EXPANDED_LIMIT, unit: "bytes" }]]);

export const ANDROID_SPARSE_IMAGE_LIMITATIONS = {
  inventoryScope:
    "Android sparse image inventory reads the sparse header and chunk table and expands one raw partition image offline. No host tool, decompression, or mount is used.",
  checksumUnverified:
    "The stored image checksum and CRC32 chunk values were recorded and not verified.",
  dontCare:
    "DONT_CARE chunks were expanded as zeros; the original block contents are unknown.",
  fileHeaderExtra:
    "File header bytes past the 28-byte structure were not decoded.",
  chunkHeaderExtra:
    "Chunk header bytes past the 12-byte structure were not decoded.",
} as const;

const FORMAT = "android-sparse-image";

/**
 * How parsing a sparse image failed: a short header or chunk is `truncated`,
 * an unknown chunk or a size that does not add up is `malformed`, a major
 * version other than 1 is `unsupported`, and the safe-integer byte ceiling is
 * `limit`.
 */
export type AndroidSparseImageParseError =
  | ParseFailureError<"malformed">
  | ParseFailureError<"truncated">
  | ParseFailureError<"unsupported">
  | ParseFailureError<"limit">;

export type AndroidSparseImageRecognition =
  | { readonly state: "recognized" }
  | { readonly state: "refused"; readonly reason: string };

export interface AndroidSparseHeader {
  readonly magic: typeof ANDROID_SPARSE_MAGIC;
  readonly majorVersion: 1;
  readonly minorVersion: number;
  readonly fileHeaderSize: number;
  readonly chunkHeaderSize: number;
  readonly blockSize: number;
  readonly totalBlocks: number;
  readonly totalChunks: number;
  /** Stored CRC32 of the expanded image. This reader does not check it. */
  readonly imageChecksum: number;
}

export type AndroidSparseChunk =
  | {
      readonly kind: "raw";
      readonly index: number;
      readonly fileOffset: number;
      readonly totalSize: number;
      readonly outputBytes: number;
      readonly dataOffset: number;
    }
  | {
      readonly kind: "fill";
      readonly index: number;
      readonly fileOffset: number;
      readonly totalSize: number;
      readonly outputBytes: number;
      readonly pattern: Uint8Array;
    }
  | {
      readonly kind: "dont-care";
      readonly index: number;
      readonly fileOffset: number;
      readonly totalSize: number;
      readonly outputBytes: number;
    }
  | {
      readonly kind: "crc32";
      readonly index: number;
      readonly fileOffset: number;
      readonly totalSize: number;
      readonly outputBytes: 0;
      readonly value: number;
    };

/** One ordered expansion step. Zero-length chunks are omitted. */
export type AndroidSparseRun =
  | { readonly kind: "raw"; readonly offset: number; readonly length: number }
  | {
      readonly kind: "fill";
      readonly pattern: Uint8Array;
      readonly length: number;
    }
  | { readonly kind: "dont-care"; readonly length: number };

export interface AndroidSparseChunkCounts {
  readonly raw: number;
  readonly fill: number;
  readonly dontCare: number;
  readonly crc32: number;
}

export interface AndroidSparseImage {
  readonly header: AndroidSparseHeader;
  readonly expandedBytes: number;
  readonly counts: AndroidSparseChunkCounts;
  /** Expanded output bytes covered by each chunk type. CRC32 covers none. */
  readonly coveredBytes: Omit<AndroidSparseChunkCounts, "crc32">;
  /** The first 16 distinct FILL patterns as hex; `counts.fill` counts every FILL chunk. */
  readonly fillPatterns: readonly string[];
  /** The first 16 CRC32 chunks; `counts.crc32` counts them all. */
  readonly crc32Chunks: readonly {
    readonly fileOffset: number;
    readonly value: number;
  }[];
  readonly undecodedFileHeaderBytes: number;
  readonly undecodedFileHeaderHex: string;
  readonly chunkHeaderExtraBytes: number;
  readonly trailingBytes: number;
  readonly runs: readonly AndroidSparseRun[];
  readonly limitations: readonly string[];
}

const malformed = (
  detail: string,
  offset?: number,
  field?: string,
): AndroidSparseImageParseError =>
  malformedInput(FORMAT, detail, {
    ...(offset === undefined ? {} : { offset }),
    ...(field === undefined ? {} : { field }),
  });

const truncated = (
  detail: string,
  offset?: number,
  field?: string,
): AndroidSparseImageParseError =>
  truncatedInput(FORMAT, detail, {
    ...(offset === undefined ? {} : { offset }),
    ...(field === undefined ? {} : { field }),
  });

export const androidSparseUnsupportedMajor = (major: number): string =>
  `Android sparse image major version ${String(major)} is unsupported; this reader supports version 1 only`;

/** Little-endian field reader; callers check each structure's length first. */
const fields = (bytes: Uint8Array): BinaryReader =>
  new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    FORMAT,
  );

const hexBytes = (bytes: Uint8Array): string =>
  Buffer.from(bytes.subarray(0, UNDECODED_HEX_BYTES)).toString("hex");

export const hasAndroidSparseImageMagic = (prefix: Uint8Array): boolean =>
  prefix.length >= 4 && fields(prefix).u32(0) === ANDROID_SPARSE_MAGIC;

/** Recognize magic `0xED26FF3A`. Major version 1 is supported; any other readable major is refused. */
export const recognizeAndroidSparseImage = (
  prefix: Uint8Array,
): AndroidSparseImageRecognition | undefined => {
  if (!hasAndroidSparseImageMagic(prefix)) return undefined;
  if (prefix.length < 6) return { state: "recognized" };
  const major = fields(prefix).u16(4);
  return major === ANDROID_SPARSE_MAJOR_VERSION
    ? { state: "recognized" }
    : {
        state: "refused",
        reason: androidSparseUnsupportedMajor(major),
      };
};

const expandedCeiling = (required: bigint): AndroidSparseImageParseError =>
  decodeLimit(
    FORMAT,
    "Android sparse expanded image exceeds the largest safe integer byte count",
    {
      ...EXPANDED_LIMIT,
      required,
    },
    { field: "total_blks" },
  );

const outputBytesFor = (
  header: AndroidSparseHeader,
  blocks: number,
): Result<number, AndroidSparseImageParseError> => {
  const output = BigInt(blocks) * BigInt(header.blockSize);
  if (output > BigInt(Number.MAX_SAFE_INTEGER))
    return err(expandedCeiling(output));
  return ok(Number(output));
};

/**
 * Parse the fixed 28-byte sparse header. `bytes` needs only those 28 bytes;
 * the `file_hdr_sz` extension that follows is read and kept separately.
 */
export const parseAndroidSparseFileHeader = (
  bytes: Uint8Array,
  fileSize: number,
): Result<AndroidSparseHeader, AndroidSparseImageParseError> => {
  const recognition = recognizeAndroidSparseImage(bytes.subarray(0, fileSize));
  if (recognition === undefined)
    return err(malformed("magic is not 0xed26ff3a", 0, "magic"));
  if (recognition.state === "refused")
    return err(
      unsupportedInput(FORMAT, recognition.reason, {
        offset: 4,
        field: "major_version",
      }),
    );
  if (
    fileSize < ANDROID_SPARSE_FILE_HEADER_BYTES ||
    bytes.length < ANDROID_SPARSE_FILE_HEADER_BYTES
  )
    return err(truncated("sparse header is truncated", 0, "sparse_header"));
  const reader = fields(bytes);
  const minorVersion = reader.u16(6);
  const fileHeaderSize = reader.u16(8);
  const chunkHeaderSize = reader.u16(10);
  const blockSize = reader.u32(12);
  const totalBlocks = reader.u32(16);
  const totalChunks = reader.u32(20);
  const imageChecksum = reader.u32(24);
  if (fileHeaderSize < ANDROID_SPARSE_FILE_HEADER_BYTES)
    return err(
      malformed(
        `file_hdr_sz ${String(fileHeaderSize)} is smaller than the 28-byte structure`,
        8,
        "file_hdr_sz",
      ),
    );
  if (chunkHeaderSize < ANDROID_SPARSE_CHUNK_HEADER_BYTES)
    return err(
      malformed(
        `chunk_hdr_sz ${String(chunkHeaderSize)} is smaller than the 12-byte structure`,
        10,
        "chunk_hdr_sz",
      ),
    );
  if (blockSize === 0)
    return err(malformed("block size is zero", 12, "blk_sz"));
  if (blockSize % 4 !== 0)
    return err(
      malformed(
        `block size ${String(blockSize)} is not a multiple of 4`,
        12,
        "blk_sz",
      ),
    );
  if (fileHeaderSize > fileSize)
    return err(
      truncated(
        `sparse header declares file_hdr_sz ${String(fileHeaderSize)} but the file has ${String(fileSize)} bytes`,
        8,
        "file_hdr_sz",
      ),
    );
  // Every chunk spans at least its header inside the file, so a table that
  // cannot fit is truncated input, not a reason to raise a chunk budget.
  const chunkTableBytes = totalChunks * chunkHeaderSize;
  if (chunkTableBytes > fileSize - fileHeaderSize)
    return err(
      truncated(
        `total_chunks ${String(totalChunks)} needs at least ${String(chunkTableBytes)} chunk-header bytes but ${String(fileSize - fileHeaderSize)} follow the sparse header`,
        20,
        "total_chunks",
      ),
    );
  return ok({
    magic: ANDROID_SPARSE_MAGIC,
    majorVersion: 1,
    minorVersion,
    fileHeaderSize,
    chunkHeaderSize,
    blockSize,
    totalBlocks,
    totalChunks,
    imageChecksum,
  });
};

/** Parse the sparse header from bytes that include the whole `file_hdr_sz` extension. */
export const parseAndroidSparseHeader = (
  bytes: Uint8Array,
  fileSize: number,
): Result<
  { readonly header: AndroidSparseHeader; readonly undecoded: Uint8Array },
  AndroidSparseImageParseError
> => {
  const parsed = parseAndroidSparseFileHeader(bytes, fileSize);
  if (!parsed.ok) return parsed;
  const header = parsed.value;
  if (bytes.length < header.fileHeaderSize)
    return err(
      truncated(
        `sparse header declares file_hdr_sz ${String(header.fileHeaderSize)} but ${String(bytes.length)} header bytes were supplied`,
        8,
        "file_hdr_sz",
      ),
    );
  return ok({
    header,
    undecoded: bytes.subarray(
      ANDROID_SPARSE_FILE_HEADER_BYTES,
      header.fileHeaderSize,
    ),
  });
};

/** Expanded byte count the header declares, before any chunk is walked. */
export const androidSparseDeclaredExpandedBytes = (
  header: AndroidSparseHeader,
): Result<number, AndroidSparseImageParseError> => {
  const expanded = BigInt(header.totalBlocks) * BigInt(header.blockSize);
  if (expanded > BigInt(Number.MAX_SAFE_INTEGER))
    return err(expandedCeiling(expanded));
  return ok(Number(expanded));
};

/**
 * Parse one chunk header at `fileOffset`.
 * `bytes` starts at the chunk and includes the chunk header. FILL and CRC32
 * also include their 4-byte value. RAW payload bytes are not required.
 */
export const parseAndroidSparseChunk = (
  header: AndroidSparseHeader,
  bytes: Uint8Array,
  fileOffset: number,
  fileSize: number,
  index: number,
): Result<AndroidSparseChunk, AndroidSparseImageParseError> => {
  if (fileSize - fileOffset < header.chunkHeaderSize || bytes.length < 12)
    return err(
      truncated(
        `chunk ${String(index)} header is truncated`,
        fileOffset,
        "chunk_header",
      ),
    );
  const reader = fields(bytes);
  const type = reader.u16(0);
  const chunkBlocks = reader.u32(4);
  const totalSize = reader.u32(8);
  if (
    type !== ANDROID_SPARSE_CHUNK_RAW &&
    type !== ANDROID_SPARSE_CHUNK_FILL &&
    type !== ANDROID_SPARSE_CHUNK_DONT_CARE &&
    type !== ANDROID_SPARSE_CHUNK_CRC32
  )
    return err(
      malformed(
        `chunk ${String(index)} type 0x${type.toString(16)} is unknown`,
        fileOffset,
        "chunk_type",
      ),
    );
  if (totalSize < header.chunkHeaderSize)
    return err(
      malformed(
        `chunk ${String(index)} total_sz ${String(totalSize)} is smaller than its chunk header`,
        fileOffset + 8,
        "total_sz",
      ),
    );
  if (totalSize > fileSize - fileOffset)
    return err(
      truncated(
        type === ANDROID_SPARSE_CHUNK_RAW
          ? `chunk ${String(index)} raw data is truncated`
          : `chunk ${String(index)} is truncated`,
        fileOffset,
        "total_sz",
      ),
    );
  if (bytes.length < header.chunkHeaderSize)
    return err(
      truncated(
        `chunk ${String(index)} header is truncated`,
        fileOffset,
        "chunk_header",
      ),
    );
  if (type === ANDROID_SPARSE_CHUNK_CRC32 && chunkBlocks !== 0)
    return err(
      malformed(
        `chunk ${String(index)} CRC32 chunk_sz ${String(chunkBlocks)} must be 0`,
        fileOffset + 4,
        "chunk_sz",
      ),
    );
  if (chunkBlocks > header.totalBlocks)
    return err(
      malformed(
        `chunk ${String(index)} chunk_sz ${String(chunkBlocks)} exceeds total_blks ${String(header.totalBlocks)}`,
        fileOffset + 4,
        "chunk_sz",
      ),
    );
  const output =
    type === ANDROID_SPARSE_CHUNK_CRC32
      ? ok(0)
      : outputBytesFor(header, chunkBlocks);
  if (!output.ok) return output;
  const outputBytes = output.value;
  if (
    type === ANDROID_SPARSE_CHUNK_RAW &&
    outputBytes > Number.MAX_SAFE_INTEGER - header.chunkHeaderSize
  )
    return err(
      malformed(
        `chunk ${String(index)} output does not fit beside its chunk header`,
        undefined,
        "chunk_sz",
      ),
    );
  const expected =
    type === ANDROID_SPARSE_CHUNK_RAW
      ? header.chunkHeaderSize + outputBytes
      : type === ANDROID_SPARSE_CHUNK_FILL ||
          type === ANDROID_SPARSE_CHUNK_CRC32
        ? header.chunkHeaderSize + 4
        : header.chunkHeaderSize;
  if (totalSize !== expected)
    return err(
      malformed(
        `chunk ${String(index)} total_sz ${String(totalSize)} does not match the ${String(expected)} bytes its type requires`,
        fileOffset + 8,
        "total_sz",
      ),
    );
  const base = {
    index,
    fileOffset,
    totalSize,
  };
  if (type === ANDROID_SPARSE_CHUNK_RAW)
    return ok({
      ...base,
      kind: "raw",
      outputBytes,
      dataOffset: fileOffset + header.chunkHeaderSize,
    });
  if (type === ANDROID_SPARSE_CHUNK_DONT_CARE)
    return ok({ ...base, kind: "dont-care", outputBytes });
  if (bytes.length < header.chunkHeaderSize + 4)
    return err(
      truncated(
        `chunk ${String(index)} is truncated`,
        fileOffset + header.chunkHeaderSize,
        "chunk_data",
      ),
    );
  if (type === ANDROID_SPARSE_CHUNK_FILL)
    return ok({
      ...base,
      kind: "fill",
      outputBytes,
      pattern: Uint8Array.from(
        bytes.subarray(header.chunkHeaderSize, header.chunkHeaderSize + 4),
      ),
    });
  return ok({
    ...base,
    kind: "crc32",
    outputBytes: 0,
    value: reader.u32(header.chunkHeaderSize),
  });
};

/** Walk every chunk in `bytes` and require the output block count to equal `total_blks`. */
export const parseAndroidSparseImage = (
  bytes: Uint8Array,
): Result<AndroidSparseImage, AndroidSparseImageParseError> => {
  const fileSize = bytes.length;
  const parsed = parseAndroidSparseHeader(bytes, fileSize);
  if (!parsed.ok) return parsed;
  const { header, undecoded } = parsed.value;
  const accumulator = new AndroidSparseImageAccumulator(header, undecoded);
  for (let index = 0; index < header.totalChunks; index += 1) {
    const chunk = parseAndroidSparseChunk(
      header,
      bytes.subarray(accumulator.nextOffset),
      accumulator.nextOffset,
      fileSize,
      index,
    );
    if (!chunk.ok) return chunk;
    accumulator.add(chunk.value);
  }
  return accumulator.finish(fileSize);
};

/**
 * Collect sparse-image facts one walked chunk at a time. Only the expansion
 * runs, counts, the first distinct FILL patterns and the first CRC32 values are kept.
 */
export class AndroidSparseImageAccumulator {
  readonly #header: AndroidSparseHeader;
  readonly #undecodedFileHeader: Uint8Array;
  #walked = 0;
  #blocks = 0n;
  #end: number;
  readonly #counts = { raw: 0, fill: 0, dontCare: 0, crc32: 0 };
  readonly #covered = { raw: 0, fill: 0, dontCare: 0 };
  readonly #fillPatterns = new Set<string>();
  #fillPatternsOmitted = false;
  readonly #crc32Chunks: { fileOffset: number; value: number }[] = [];
  readonly #runs: AndroidSparseRun[] = [];

  constructor(header: AndroidSparseHeader, undecodedFileHeader: Uint8Array) {
    this.#header = header;
    this.#undecodedFileHeader = undecodedFileHeader;
    this.#end = header.fileHeaderSize;
  }

  /** File offset of the next chunk header. */
  get nextOffset(): number {
    return this.#end;
  }

  add(chunk: AndroidSparseChunk): void {
    this.#walked += 1;
    this.#blocks += BigInt(chunk.outputBytes) / BigInt(this.#header.blockSize);
    this.#end += chunk.totalSize;
    if (chunk.kind === "raw") {
      this.#counts.raw += 1;
      this.#covered.raw += chunk.outputBytes;
      if (chunk.outputBytes > 0)
        this.#runs.push({
          kind: "raw",
          offset: chunk.dataOffset,
          length: chunk.outputBytes,
        });
    } else if (chunk.kind === "fill") {
      this.#counts.fill += 1;
      this.#covered.fill += chunk.outputBytes;
      const pattern = Buffer.from(chunk.pattern).toString("hex");
      if (!this.#fillPatterns.has(pattern)) {
        if (this.#fillPatterns.size < ANDROID_SPARSE_LISTED_CHUNKS)
          this.#fillPatterns.add(pattern);
        else this.#fillPatternsOmitted = true;
      }
      if (chunk.outputBytes > 0)
        this.#runs.push({
          kind: "fill",
          pattern: chunk.pattern,
          length: chunk.outputBytes,
        });
    } else if (chunk.kind === "dont-care") {
      this.#counts.dontCare += 1;
      this.#covered.dontCare += chunk.outputBytes;
      if (chunk.outputBytes > 0)
        this.#runs.push({ kind: "dont-care", length: chunk.outputBytes });
    } else {
      this.#counts.crc32 += 1;
      if (this.#crc32Chunks.length < ANDROID_SPARSE_LISTED_CHUNKS)
        this.#crc32Chunks.push({
          fileOffset: chunk.fileOffset,
          value: chunk.value,
        });
    }
  }

  /** Check the walked chunks against the header and build the image. */
  finish(
    fileSize: number,
  ): Result<AndroidSparseImage, AndroidSparseImageParseError> {
    const header = this.#header;
    const counts = { ...this.#counts };
    const fillPatterns = [...this.#fillPatterns];
    const crc32Chunks = [...this.#crc32Chunks];
    if (this.#walked !== header.totalChunks)
      return err(
        malformed(
          `walked ${String(this.#walked)} chunks but total_chunks is ${String(header.totalChunks)}`,
          undefined,
          "total_chunks",
        ),
      );
    if (this.#blocks !== BigInt(header.totalBlocks))
      return err(
        malformed(
          `output block count ${this.#blocks.toString()} does not equal total_blks ${String(header.totalBlocks)}`,
          16,
          "total_blks",
        ),
      );
    const expanded = BigInt(header.totalBlocks) * BigInt(header.blockSize);
    if (expanded > BigInt(Number.MAX_SAFE_INTEGER))
      return err(expandedCeiling(expanded));
    const undecodedFileHeader = this.#undecodedFileHeader;
    const trailingBytes = fileSize - this.#end;
    const limitations: string[] = [
      ANDROID_SPARSE_IMAGE_LIMITATIONS.checksumUnverified,
    ];
    if (header.minorVersion !== 0)
      limitations.push(
        `Minor version ${String(header.minorVersion)} is newer than 0; only the version 1.0 header and chunk fields were decoded.`,
      );
    if (undecodedFileHeader.length > 0)
      limitations.push(ANDROID_SPARSE_IMAGE_LIMITATIONS.fileHeaderExtra);
    if (undecodedFileHeader.length > UNDECODED_HEX_BYTES)
      limitations.push(
        `The hex preview shows the first ${String(UNDECODED_HEX_BYTES)} extension bytes and omits ${String(undecodedFileHeader.length - UNDECODED_HEX_BYTES)} bytes.`,
      );
    if (header.chunkHeaderSize > ANDROID_SPARSE_CHUNK_HEADER_BYTES)
      limitations.push(ANDROID_SPARSE_IMAGE_LIMITATIONS.chunkHeaderExtra);
    if (counts.dontCare > 0)
      limitations.push(ANDROID_SPARSE_IMAGE_LIMITATIONS.dontCare);
    if (this.#fillPatternsOmitted)
      limitations.push(
        `Fill patterns after the first ${String(ANDROID_SPARSE_LISTED_CHUNKS)} distinct values were omitted.`,
      );
    if (counts.crc32 > crc32Chunks.length)
      limitations.push(
        `CRC32 chunks after the first ${String(ANDROID_SPARSE_LISTED_CHUNKS)} were counted and not listed.`,
      );
    if (trailingBytes > 0)
      limitations.push(
        `${String(trailingBytes)} bytes after the declared chunks were not decoded.`,
      );
    return ok({
      header,
      expandedBytes: Number(expanded),
      counts,
      coveredBytes: { ...this.#covered },
      fillPatterns,
      crc32Chunks,
      undecodedFileHeaderBytes: undecodedFileHeader.length,
      undecodedFileHeaderHex: hexBytes(undecodedFileHeader),
      chunkHeaderExtraBytes:
        header.chunkHeaderSize - ANDROID_SPARSE_CHUNK_HEADER_BYTES,
      trailingBytes,
      runs: this.#runs,
      limitations,
    });
  }
}
