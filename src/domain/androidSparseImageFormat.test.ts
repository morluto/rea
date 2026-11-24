import { describe, expect, it } from "vitest";
import {
  ANDROID_SPARSE_CHUNK_COUNT_LIMIT,
  ANDROID_SPARSE_CHUNK_HEADER_SIZE,
  ANDROID_SPARSE_CHUNK_TYPE_CRC32,
  ANDROID_SPARSE_CHUNK_TYPE_DONT_CARE,
  ANDROID_SPARSE_CHUNK_TYPE_FILL,
  ANDROID_SPARSE_CHUNK_TYPE_RAW,
  ANDROID_SPARSE_HEADER_SIZE,
  ANDROID_SPARSE_MAGIC,
  ANDROID_SPARSE_MAX_METADATA_CHUNKS,
  ANDROID_SPARSE_MAX_METADATA_CRC32_VALUES,
  hasAndroidSparseImageMagic,
  inspectAndroidSparseBuffer,
} from "./androidSparseImageFormat.js";
import { ParseFailureError } from "./parseFailure.js";
import { buildAndroidSparseImage } from "../../tests/fixtures/androidSparseImage.js";

const expectParseFailure = (
  fn: () => unknown,
  expected: Record<string, unknown>,
): ParseFailureError => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ParseFailureError);
  expect((caught as ParseFailureError).failure).toMatchObject(expected);
  return caught as ParseFailureError;
};

describe("androidSparseImageFormat", () => {
  it("detects little-endian sparse magic 0xed26ff3a", () => {
    expect(
      hasAndroidSparseImageMagic(Buffer.from([0x3a, 0xff, 0x26, 0xed])),
    ).toBe(true);
    expect(hasAndroidSparseImageMagic(Buffer.from([0x3a, 0xff, 0x26]))).toBe(
      false,
    );
    expect(
      hasAndroidSparseImageMagic(Buffer.from([0xed, 0x26, 0xff, 0x3a])),
    ).toBe(false);
  });

  it("parses RAW, FILL, DONT_CARE, and CRC32 chunks and accounts virtual blocks without allocation", () => {
    const rawBlock = Buffer.alloc(4096, 0x41);
    rawBlock.write("SYNTHETIC_EXT4_HEADER", 1024, "utf8");
    const sparse = buildAndroidSparseImage({
      minorVersion: 2,
      fileHdrSz: 36,
      chunkHdrSz: 16,
      blkSz: 4096,
      imageChecksum: 0x12345678,
      extraHeaderBytes: Buffer.alloc(8, 0xaa),
      chunks: [
        { kind: "raw", data: rawBlock, reserved: 7 },
        { kind: "fill", blocks: 1_048_576, pattern: 0xfeedface }, // 4 GiB virtual fill
        { kind: "dont_care", blocks: 2_097_152 }, // 8 GiB virtual dont_care
        { kind: "crc32", crc32: 0xdeadbeef },
      ],
    });

    // Carrier stays compact despite >12 GiB declared virtual image size
    expect(sparse.length).toBeLessThan(8192);

    const parsed = inspectAndroidSparseBuffer(sparse);
    expect(parsed.complete).toBe(true);
    expect(parsed.rawEntries).toHaveLength(1);
    expect(parsed.rawEntries[0]).toMatchObject({
      path: "chunks/chunk-0000-raw.bin",
      byteOffset: 36 + 16,
      declaredSize: 4096,
      chunkIndex: 0,
      metadata: {
        kind: "android-sparse-chunk",
        chunk_index: 0,
        chunk_type: ANDROID_SPARSE_CHUNK_TYPE_RAW,
        chunk_type_name: "raw",
        reserved: 7,
        file_offset: 36,
        data_offset: 52,
        total_size: 16 + 4096,
        output_block_offset: 0,
        output_byte_offset: 0,
        output_blocks: 1,
        output_bytes: 4096,
      },
    });
    expect(parsed.metadata).toMatchObject({
      kind: "android-sparse-image",
      magic: ANDROID_SPARSE_MAGIC,
      major_version: 1,
      minor_version: 2,
      file_header_size: 36,
      chunk_header_size: 16,
      block_size: 4096,
      total_blocks: 1 + 1_048_576 + 2_097_152,
      total_chunks: 4,
      image_checksum: 0x12345678,
      unsparsed_size: (1 + 1_048_576 + 2_097_152) * 4096,
      file_size: sparse.length,
      parsed_bytes: sparse.length,
      trailing_bytes: 0,
      raw_chunk_count: 1,
      fill_chunk_count: 1,
      dont_care_chunk_count: 1,
      crc32_chunk_count: 1,
      raw_blocks: 1,
      fill_blocks: 1_048_576,
      dont_care_blocks: 2_097_152,
      raw_data_bytes: 4096,
      virtual_fill_bytes: 1_048_576 * 4096,
      virtual_dont_care_bytes: 2_097_152 * 4096,
      crc32_verified: false,
      crc32_chunk_values: [0xdeadbeef],
      crc32_chunk_values_omitted: 0,
      chunks_omitted: 0,
    });
    expect(parsed.metadata.chunks).toEqual([
      expect.objectContaining({
        chunk_index: 0,
        chunk_type: ANDROID_SPARSE_CHUNK_TYPE_RAW,
        chunk_type_name: "raw",
        entry_path: "chunks/chunk-0000-raw.bin",
      }),
      expect.objectContaining({
        chunk_index: 1,
        chunk_type: ANDROID_SPARSE_CHUNK_TYPE_FILL,
        chunk_type_name: "fill",
        output_block_offset: 1,
        output_byte_offset: 4096,
        fill_pattern: 0xfeedface,
        entry_path: null,
      }),
      expect.objectContaining({
        chunk_index: 2,
        chunk_type: ANDROID_SPARSE_CHUNK_TYPE_DONT_CARE,
        chunk_type_name: "dont_care",
        output_block_offset: 1 + 1_048_576,
        entry_path: null,
      }),
      expect.objectContaining({
        chunk_index: 3,
        chunk_type: ANDROID_SPARSE_CHUNK_TYPE_CRC32,
        chunk_type_name: "crc32",
        crc32: 0xdeadbeef,
        entry_path: null,
      }),
    ]);
  });

  it("supports large uint16 file_hdr_sz and chunk_hdr_sz within carrier file bounds", () => {
    const sparse = buildAndroidSparseImage({
      fileHdrSz: 8192,
      chunkHdrSz: 2048,
      chunks: [{ kind: "dont_care", blocks: 2 }],
    });
    const parsed = inspectAndroidSparseBuffer(sparse);
    expect(parsed.complete).toBe(true);
    expect(parsed.metadata).toMatchObject({
      file_header_size: 8192,
      chunk_header_size: 2048,
      total_chunks: 1,
      dont_care_blocks: 2,
    });
  });

  it("bounds inline chunks and crc32 lists while preserving full aggregate counters", () => {
    const chunkCount = ANDROID_SPARSE_MAX_METADATA_CHUNKS + 20;
    const chunks = Array.from({ length: chunkCount }, (_, index) =>
      index < ANDROID_SPARSE_MAX_METADATA_CRC32_VALUES + 5
        ? ({ kind: "crc32", crc32: index + 1 } as const)
        : ({ kind: "dont_care", blocks: 1 } as const),
    );
    const sparse = buildAndroidSparseImage({ chunks });
    const parsed = inspectAndroidSparseBuffer(sparse);

    expect(parsed.complete).toBe(true);
    expect(parsed.metadata.total_chunks).toBe(chunkCount);
    expect(parsed.metadata.chunks).toHaveLength(
      ANDROID_SPARSE_MAX_METADATA_CHUNKS,
    );
    expect(parsed.metadata.chunks_omitted).toBe(20);
    expect(parsed.metadata.crc32_chunk_count).toBe(
      ANDROID_SPARSE_MAX_METADATA_CRC32_VALUES + 5,
    );
    expect(parsed.metadata.crc32_chunk_values).toHaveLength(
      ANDROID_SPARSE_MAX_METADATA_CRC32_VALUES,
    );
    expect(parsed.metadata.crc32_chunk_values_omitted).toBe(5);
    expect(
      parsed.limitations.some((l) => l.includes("Inline chunks list")),
    ).toBe(true);
  });

  it("tracks trailing bytes cleanly with unknown coverage state", () => {
    const sparse = buildAndroidSparseImage({
      chunks: [{ kind: "dont_care", blocks: 2 }],
      trailingBytes: Buffer.from([1, 2, 3, 4, 5]),
    });
    const parsed = inspectAndroidSparseBuffer(sparse);
    expect(parsed.complete).toBe(false);
    expect(parsed.metadata.trailing_bytes).toBe(5);
    expect(
      parsed.limitations.some((l) => l.includes("5 trailing byte(s)")),
    ).toBe(true);
  });

  it("rejects truncated headers, unsupported versions, and bad header fields", () => {
    expectParseFailure(
      () => inspectAndroidSparseBuffer(Buffer.from([0x3a, 0xff, 0x26, 0xed])),
      { kind: "truncated", field: "sparse_header" },
    );

    expectParseFailure(
      () => inspectAndroidSparseBuffer(buildAndroidSparseImage({ magic: 0 })),
      { kind: "malformed", field: "magic", offset: 0 },
    );

    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({ majorVersion: 2 }),
        ),
      { kind: "unsupported", field: "major_version", offset: 4 },
    );

    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({
            fileHdrSz: ANDROID_SPARSE_HEADER_SIZE - 1,
          }),
        ),
      { kind: "malformed", field: "file_hdr_sz", offset: 8 },
    );

    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({ fileHdrSz: 4096 }).subarray(0, 100),
        ),
      { kind: "truncated", field: "file_hdr_sz", offset: 0 },
    );

    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({
            chunkHdrSz: ANDROID_SPARSE_CHUNK_HEADER_SIZE - 1,
          }),
        ),
      { kind: "malformed", field: "chunk_hdr_sz", offset: 10 },
    );

    expectParseFailure(
      () => inspectAndroidSparseBuffer(buildAndroidSparseImage({ blkSz: 0 })),
      { kind: "malformed", field: "blk_sz", offset: 12 },
    );

    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(buildAndroidSparseImage({ blkSz: 4098 })),
      { kind: "malformed", field: "blk_sz", offset: 12 },
    );
  });

  it("rejects impossible total_chunks dimensions as truncated before enforcing adjustable chunk_count", () => {
    // A 28-byte image claiming 0xffffffff chunks cannot physically store them; fail truncated, not retryable limit.
    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({ totalChunks: 0xffff_ffff }),
          { chunkCountLimit: 2 },
        ),
      { kind: "truncated", field: "total_chunks", offset: 20 },
    );

    // When the carrier physically holds all chunk headers, enforce chunkCountLimit and allow raising it.
    const threeChunkImage = buildAndroidSparseImage({
      chunks: [
        { kind: "dont_care", blocks: 1 },
        { kind: "dont_care", blocks: 2 },
        { kind: "dont_care", blocks: 3 },
      ],
    });
    expectParseFailure(
      () => inspectAndroidSparseBuffer(threeChunkImage, { chunkCountLimit: 2 }),
      {
        kind: "limit",
        limit: {
          name: ANDROID_SPARSE_CHUNK_COUNT_LIMIT.name,
          maximum: 2,
          required: 3,
        },
      },
    );
    expect(
      inspectAndroidSparseBuffer(threeChunkImage, { chunkCountLimit: 3 })
        .metadata.total_chunks,
    ).toBe(3);
  });

  it("rejects integer overflows, total_blks mismatches, unknown chunk types, and chunk truncation", () => {
    // total_blks * blk_sz overflows Number.MAX_SAFE_INTEGER
    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({
            blkSz: 0x8000_0000,
            totalBlks: 0x0100_0000,
            totalChunks: 0,
          }),
        ),
      { kind: "malformed", field: "total_blks" },
    );

    // Accumulated chunk_sz overflows uint32 mod 2^32 (0x80000001 + 0x80000001 === 2 mod 2^32)
    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({
            totalBlks: 2,
            chunks: [
              { kind: "dont_care", blocks: 0x8000_0001 },
              { kind: "dont_care", blocks: 0x8000_0001 },
            ],
          }),
        ),
      { kind: "malformed", field: "chunk_sz" },
    );

    // Accumulated blocks mismatch total_blks
    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({
            totalBlks: 5,
            chunks: [{ kind: "dont_care", blocks: 4 }],
          }),
        ),
      { kind: "malformed", field: "total_blks" },
    );

    // RAW total_sz mismatch (or wrap)
    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({
            totalBlks: 1,
            chunks: [{ kind: "raw", data: Buffer.alloc(4096), totalSize: 12 }],
          }),
        ),
      { kind: "malformed", field: "total_sz" },
    );

    // CRC32 with non-zero chunk_sz
    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({
            totalBlks: 1,
            chunks: [{ kind: "crc32", crc32: 1, chunkBlocks: 1 }],
          }),
        ),
      { kind: "malformed", field: "chunk_sz" },
    );

    // Unknown chunk type
    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(
          buildAndroidSparseImage({
            totalBlks: 1,
            chunks: [
              {
                kind: "custom",
                chunkType: 0xdead,
                chunkBlocks: 1,
                totalSize: 12,
              },
            ],
          }),
        ),
      { kind: "malformed", field: "chunk_type" },
    );

    // Truncated RAW payload
    const validRaw = buildAndroidSparseImage({
      chunks: [{ kind: "raw", data: Buffer.alloc(4096) }],
    });
    expectParseFailure(
      () =>
        inspectAndroidSparseBuffer(validRaw.subarray(0, validRaw.length - 10)),
      { kind: "truncated", field: "chunk_payload" },
    );
  });
});
