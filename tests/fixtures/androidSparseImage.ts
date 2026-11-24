import {
  ANDROID_SPARSE_CHUNK_HEADER_SIZE,
  ANDROID_SPARSE_CHUNK_TYPE_CRC32,
  ANDROID_SPARSE_CHUNK_TYPE_DONT_CARE,
  ANDROID_SPARSE_CHUNK_TYPE_FILL,
  ANDROID_SPARSE_CHUNK_TYPE_RAW,
  ANDROID_SPARSE_HEADER_SIZE,
  ANDROID_SPARSE_MAGIC,
  ANDROID_SPARSE_MAJOR_VERSION,
} from "../../src/domain/androidSparseImageFormat.js";

/** One chunk specification for {@link buildAndroidSparseImage}. */
export type SyntheticSparseChunk =
  | {
      readonly kind: "raw";
      readonly data: Uint8Array;
      readonly chunkBlocks?: number;
      readonly totalSize?: number;
      readonly reserved?: number;
      readonly extraChunkHeader?: Uint8Array;
    }
  | {
      readonly kind: "fill";
      readonly blocks: number;
      readonly pattern: number;
      readonly totalSize?: number;
      readonly reserved?: number;
      readonly extraChunkHeader?: Uint8Array;
    }
  | {
      readonly kind: "dont_care";
      readonly blocks: number;
      readonly totalSize?: number;
      readonly reserved?: number;
      readonly extraChunkHeader?: Uint8Array;
    }
  | {
      readonly kind: "crc32";
      readonly crc32: number;
      readonly chunkBlocks?: number;
      readonly totalSize?: number;
      readonly reserved?: number;
      readonly extraChunkHeader?: Uint8Array;
    }
  | {
      readonly kind: "custom";
      readonly chunkType: number;
      readonly chunkBlocks: number;
      readonly totalSize: number;
      readonly reserved?: number;
      readonly payload?: Uint8Array;
    };

export interface BuildAndroidSparseImageOptions {
  readonly magic?: number;
  readonly majorVersion?: number;
  readonly minorVersion?: number;
  readonly fileHdrSz?: number;
  readonly chunkHdrSz?: number;
  readonly blkSz?: number;
  readonly totalBlks?: number;
  readonly totalChunks?: number;
  readonly imageChecksum?: number;
  readonly chunks?: readonly SyntheticSparseChunk[];
  readonly extraHeaderBytes?: Uint8Array;
  readonly trailingBytes?: Uint8Array;
}

const defaultChunkBlocks = (
  chunk: SyntheticSparseChunk,
  blkSz: number,
): number => {
  switch (chunk.kind) {
    case "raw":
      return chunk.chunkBlocks ?? (blkSz > 0 ? chunk.data.length / blkSz : 0);
    case "fill":
    case "dont_care":
      return chunk.blocks;
    case "crc32":
      return chunk.chunkBlocks ?? 0;
    case "custom":
      return chunk.chunkBlocks;
  }
};

const encodeChunk = (
  chunk: SyntheticSparseChunk,
  blkSz: number,
  chunkHdrSz: number,
): Buffer => {
  let chunkType: number;
  let chunkBlocks: number;
  let reserved = 0;
  let payload = Buffer.alloc(0);
  let extraHeader = Buffer.alloc(0);
  let totalSizeOverride: number | undefined;

  switch (chunk.kind) {
    case "raw": {
      chunkType = ANDROID_SPARSE_CHUNK_TYPE_RAW;
      chunkBlocks = defaultChunkBlocks(chunk, blkSz);
      reserved = chunk.reserved ?? 0;
      payload = Buffer.from(chunk.data);
      extraHeader = Buffer.from(chunk.extraChunkHeader ?? []);
      totalSizeOverride = chunk.totalSize;
      break;
    }
    case "fill": {
      chunkType = ANDROID_SPARSE_CHUNK_TYPE_FILL;
      chunkBlocks = chunk.blocks;
      reserved = chunk.reserved ?? 0;
      payload = Buffer.alloc(4);
      payload.writeUInt32LE(chunk.pattern >>> 0, 0);
      extraHeader = Buffer.from(chunk.extraChunkHeader ?? []);
      totalSizeOverride = chunk.totalSize;
      break;
    }
    case "dont_care": {
      chunkType = ANDROID_SPARSE_CHUNK_TYPE_DONT_CARE;
      chunkBlocks = chunk.blocks;
      reserved = chunk.reserved ?? 0;
      extraHeader = Buffer.from(chunk.extraChunkHeader ?? []);
      totalSizeOverride = chunk.totalSize;
      break;
    }
    case "crc32": {
      chunkType = ANDROID_SPARSE_CHUNK_TYPE_CRC32;
      chunkBlocks = chunk.chunkBlocks ?? 0;
      reserved = chunk.reserved ?? 0;
      payload = Buffer.alloc(4);
      payload.writeUInt32LE(chunk.crc32 >>> 0, 0);
      extraHeader = Buffer.from(chunk.extraChunkHeader ?? []);
      totalSizeOverride = chunk.totalSize;
      break;
    }
    case "custom": {
      chunkType = chunk.chunkType;
      chunkBlocks = chunk.chunkBlocks;
      reserved = chunk.reserved ?? 0;
      payload = Buffer.from(chunk.payload ?? []);
      totalSizeOverride = chunk.totalSize;
      break;
    }
  }

  const paddingLen = Math.max(0, chunkHdrSz - ANDROID_SPARSE_CHUNK_HEADER_SIZE);
  const headerBuf = Buffer.alloc(ANDROID_SPARSE_CHUNK_HEADER_SIZE + paddingLen);
  headerBuf.writeUInt16LE(chunkType & 0xffff, 0);
  headerBuf.writeUInt16LE(reserved & 0xffff, 2);
  headerBuf.writeUInt32LE(chunkBlocks >>> 0, 4);
  const computedTotalSz = chunkHdrSz + payload.length;
  headerBuf.writeUInt32LE((totalSizeOverride ?? computedTotalSz) >>> 0, 8);
  if (extraHeader.length > 0 && paddingLen > 0) {
    extraHeader.copy(
      headerBuf,
      ANDROID_SPARSE_CHUNK_HEADER_SIZE,
      0,
      Math.min(extraHeader.length, paddingLen),
    );
  }
  return Buffer.concat([headerBuf, payload]);
};

/** Builds a clean-room synthetic AOSP Android sparse (`simg`) image buffer. */
export const buildAndroidSparseImage = (
  options: BuildAndroidSparseImageOptions = {},
): Buffer => {
  const blkSz = options.blkSz ?? 4096;
  const fileHdrSz = options.fileHdrSz ?? ANDROID_SPARSE_HEADER_SIZE;
  const chunkHdrSz = options.chunkHdrSz ?? ANDROID_SPARSE_CHUNK_HEADER_SIZE;
  const chunks = options.chunks ?? [];

  const encodedChunks = chunks.map((chunk) =>
    encodeChunk(chunk, blkSz, chunkHdrSz),
  );
  const computedBlocks = chunks.reduce(
    (sum, chunk) => sum + defaultChunkBlocks(chunk, blkSz),
    0,
  );

  const headerSize = Math.max(ANDROID_SPARSE_HEADER_SIZE, fileHdrSz);
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE((options.magic ?? ANDROID_SPARSE_MAGIC) >>> 0, 0);
  header.writeUInt16LE(
    (options.majorVersion ?? ANDROID_SPARSE_MAJOR_VERSION) & 0xffff,
    4,
  );
  header.writeUInt16LE((options.minorVersion ?? 0) & 0xffff, 6);
  header.writeUInt16LE(fileHdrSz & 0xffff, 8);
  header.writeUInt16LE(chunkHdrSz & 0xffff, 10);
  header.writeUInt32LE(blkSz >>> 0, 12);
  header.writeUInt32LE((options.totalBlks ?? computedBlocks) >>> 0, 16);
  header.writeUInt32LE((options.totalChunks ?? chunks.length) >>> 0, 20);
  header.writeUInt32LE((options.imageChecksum ?? 0) >>> 0, 24);

  if (
    options.extraHeaderBytes !== undefined &&
    headerSize > ANDROID_SPARSE_HEADER_SIZE
  ) {
    Buffer.from(options.extraHeaderBytes).copy(
      header,
      ANDROID_SPARSE_HEADER_SIZE,
      0,
      Math.min(
        options.extraHeaderBytes.length,
        headerSize - ANDROID_SPARSE_HEADER_SIZE,
      ),
    );
  }

  return Buffer.concat([
    header,
    ...encodedChunks,
    ...(options.trailingBytes === undefined
      ? []
      : [Buffer.from(options.trailingBytes)]),
  ]);
};
