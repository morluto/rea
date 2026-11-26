import {
  ANDROID_SPARSE_CHUNK_CRC32,
  ANDROID_SPARSE_CHUNK_DONT_CARE,
  ANDROID_SPARSE_CHUNK_FILL,
  ANDROID_SPARSE_CHUNK_HEADER_BYTES,
  ANDROID_SPARSE_CHUNK_RAW,
  ANDROID_SPARSE_FILE_HEADER_BYTES,
  ANDROID_SPARSE_MAGIC,
} from "./androidSparseImage.js";

/** One chunk a fixture writes. A numeric type is an unknown chunk type. */
export interface AndroidSparseChunkSpec {
  readonly type: "raw" | "fill" | "dont-care" | "crc32" | number;
  readonly blocks?: number;
  readonly data?: Uint8Array;
  readonly pattern?: Uint8Array;
  readonly value?: number;
  /** Replaces the total_sz the chunk type would otherwise require. */
  readonly totalSize?: number;
}

export interface AndroidSparseImageBuild {
  readonly blockSize?: number;
  readonly majorVersion?: number;
  readonly minorVersion?: number;
  readonly fileHeaderSize?: number;
  readonly chunkHeaderSize?: number;
  readonly imageChecksum?: number;
  readonly totalBlocks?: number;
  readonly totalChunks?: number;
  readonly chunks?: readonly AndroidSparseChunkSpec[];
  readonly trailing?: Uint8Array;
}

const NAMED_TYPE = {
  raw: ANDROID_SPARSE_CHUNK_RAW,
  fill: ANDROID_SPARSE_CHUNK_FILL,
  "dont-care": ANDROID_SPARSE_CHUNK_DONT_CARE,
  crc32: ANDROID_SPARSE_CHUNK_CRC32,
} as const;

const chunkType = (type: AndroidSparseChunkSpec["type"]): number =>
  typeof type === "number" ? type : NAMED_TYPE[type];

const outputBlocks = (
  chunk: AndroidSparseChunkSpec,
  blockSize: number,
): number => {
  if (chunk.blocks !== undefined) return chunk.blocks;
  if (chunk.type === "raw" && chunk.data !== undefined)
    return chunk.data.length / blockSize;
  return 0;
};

const chunkPayload = (chunk: AndroidSparseChunkSpec): Buffer => {
  if (chunk.type === "raw") return Buffer.from(chunk.data ?? Buffer.alloc(0));
  if (chunk.type === "fill")
    return Buffer.from(chunk.pattern ?? Buffer.alloc(4));
  if (chunk.type === "crc32") {
    const value = Buffer.alloc(4);
    value.writeUInt32LE(chunk.value ?? 0, 0);
    return value;
  }
  return Buffer.alloc(0);
};

/** Build a sparse image. Extra header bytes are `0xcd`; extra chunk-header bytes are `0xab`. */
export const buildAndroidSparseImage = (
  build: AndroidSparseImageBuild = {},
): Buffer => {
  const blockSize = build.blockSize ?? 4096;
  const chunkHeaderSize =
    build.chunkHeaderSize ?? ANDROID_SPARSE_CHUNK_HEADER_BYTES;
  const fileHeaderSize =
    build.fileHeaderSize ?? ANDROID_SPARSE_FILE_HEADER_BYTES;
  const chunks = build.chunks ?? [];
  const header = Buffer.alloc(fileHeaderSize);
  header.writeUInt32LE(ANDROID_SPARSE_MAGIC, 0);
  header.writeUInt16LE(build.majorVersion ?? 1, 4);
  header.writeUInt16LE(build.minorVersion ?? 0, 6);
  header.writeUInt16LE(fileHeaderSize, 8);
  header.writeUInt16LE(chunkHeaderSize, 10);
  header.writeUInt32LE(blockSize >>> 0, 12);
  if (fileHeaderSize > ANDROID_SPARSE_FILE_HEADER_BYTES)
    header.fill(0xcd, ANDROID_SPARSE_FILE_HEADER_BYTES);
  let blocks = 0;
  const bodies: Buffer[] = [];
  for (const chunk of chunks) {
    const payload = chunkPayload(chunk);
    const blocksOut = outputBlocks(chunk, blockSize);
    if (chunk.type !== "crc32" && typeof chunk.type !== "number")
      blocks += blocksOut;
    const totalSize =
      chunk.totalSize ??
      (chunk.type === "dont-care" || typeof chunk.type === "number"
        ? chunkHeaderSize
        : chunkHeaderSize + payload.length);
    const encoded = Buffer.alloc(chunkHeaderSize);
    encoded.writeUInt16LE(chunkType(chunk.type), 0);
    encoded.writeUInt32LE(blocksOut >>> 0, 4);
    encoded.writeUInt32LE(totalSize >>> 0, 8);
    if (chunkHeaderSize > ANDROID_SPARSE_CHUNK_HEADER_BYTES)
      encoded.fill(0xab, ANDROID_SPARSE_CHUNK_HEADER_BYTES);
    bodies.push(
      encoded,
      payload.subarray(0, Math.max(0, totalSize - chunkHeaderSize)),
    );
  }
  header.writeUInt32LE((build.totalBlocks ?? blocks) >>> 0, 16);
  header.writeUInt32LE((build.totalChunks ?? chunks.length) >>> 0, 20);
  header.writeUInt32LE((build.imageChecksum ?? 0) >>> 0, 24);
  return Buffer.concat([
    header,
    ...bodies,
    Buffer.from(build.trailing ?? Buffer.alloc(0)),
  ]);
};

/**
 * Expand chunk specs the way a sparse image reader must: RAW bytes, repeated
 * FILL patterns, and zeros for DONT_CARE. CRC32 chunks add no output.
 */
export const expandAndroidSparseChunks = (
  blockSize: number,
  chunks: readonly AndroidSparseChunkSpec[],
): Buffer => {
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const blocks = outputBlocks(chunk, blockSize);
    if (chunk.type === "raw")
      parts.push(Buffer.from(chunk.data ?? Buffer.alloc(0)));
    else if (chunk.type === "fill") {
      const pattern = Buffer.from(chunk.pattern ?? Buffer.alloc(4));
      const out = Buffer.alloc(blocks * blockSize);
      for (let offset = 0; offset < out.length; offset += pattern.length)
        pattern.copy(
          out,
          offset,
          0,
          Math.min(pattern.length, out.length - offset),
        );
      parts.push(out);
    } else if (chunk.type === "dont-care")
      parts.push(Buffer.alloc(blocks * blockSize));
  }
  return Buffer.concat(parts);
};

const MIXED_RAW = Buffer.from([0x01, 0x02, 0x03, 0x04]);
const MIXED_PATTERN = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

/** RAW, FILL, DONT_CARE and CRC32, expanded to 16 literal bytes. */
export const MIXED_ANDROID_SPARSE_EXPANDED = Buffer.from([
  0x01, 0x02, 0x03, 0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0xaa, 0xbb, 0xcc, 0xdd, 0x00,
  0x00, 0x00, 0x00,
]);

export const MIXED_ANDROID_SPARSE_SHA256 =
  "f81f7e6e2eceab42f1027746375a176c13e983d7db0973cb88b57e3b6fdd150b";

export const mixedAndroidSparseChunks =
  (): readonly AndroidSparseChunkSpec[] => [
    { type: "raw", data: MIXED_RAW },
    { type: "fill", blocks: 2, pattern: MIXED_PATTERN },
    { type: "dont-care", blocks: 1 },
    { type: "crc32", value: 0x12345678 },
  ];

/** A block size of 4 keeps the four-chunk fixture smaller than one stream buffer. */
export const mixedAndroidSparseImage = (): Buffer =>
  buildAndroidSparseImage({
    blockSize: 4,
    imageChecksum: 0x89abcdef,
    chunks: mixedAndroidSparseChunks(),
  });

/**
 * `count` one-block FILL chunks with 4-byte blocks, written in one buffer so
 * million-chunk tables stay cheap to build. Chunk `i` repeats `u32le(i)`.
 */
export const oneBlockFillAndroidSparseImage = (count: number): Buffer => {
  const chunkBytes = ANDROID_SPARSE_CHUNK_HEADER_BYTES + 4;
  const bytes = Buffer.alloc(
    ANDROID_SPARSE_FILE_HEADER_BYTES + count * chunkBytes,
  );
  bytes.writeUInt32LE(ANDROID_SPARSE_MAGIC, 0);
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(ANDROID_SPARSE_FILE_HEADER_BYTES, 8);
  bytes.writeUInt16LE(ANDROID_SPARSE_CHUNK_HEADER_BYTES, 10);
  bytes.writeUInt32LE(4, 12);
  bytes.writeUInt32LE(count, 16);
  bytes.writeUInt32LE(count, 20);
  for (let index = 0; index < count; index += 1) {
    const at = ANDROID_SPARSE_FILE_HEADER_BYTES + index * chunkBytes;
    bytes.writeUInt16LE(ANDROID_SPARSE_CHUNK_FILL, at);
    bytes.writeUInt32LE(1, at + 4);
    bytes.writeUInt32LE(chunkBytes, at + 8);
    bytes.writeUInt32LE(index, at + ANDROID_SPARSE_CHUNK_HEADER_BYTES);
  }
  return bytes;
};
