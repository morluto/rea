import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import {
  ANDROID_SPARSE_IMAGE_LIMITATIONS,
  ANDROID_SPARSE_LISTED_CHUNKS,
  AndroidSparseImageAccumulator,
  androidSparseUnsupportedMajor,
  parseAndroidSparseChunk,
  parseAndroidSparseFileHeader,
  parseAndroidSparseHeader,
  parseAndroidSparseImage,
  recognizeAndroidSparseImage,
  type AndroidSparseRun,
} from "./androidSparseImage.js";
import {
  MIXED_ANDROID_SPARSE_EXPANDED,
  MIXED_ANDROID_SPARSE_SHA256,
  buildAndroidSparseImage,
  mixedAndroidSparseImage,
  oneBlockFillAndroidSparseImage,
} from "./androidSparseImage.fixture.js";

/** Expand runs against the image bytes the way the reader streams them. */
const expand = (bytes: Buffer, runs: readonly AndroidSparseRun[]): Buffer =>
  Buffer.concat(
    runs.map((run) =>
      run.kind === "raw"
        ? bytes.subarray(run.offset, run.offset + run.length)
        : run.kind === "fill"
          ? Buffer.alloc(run.length, run.pattern)
          : Buffer.alloc(run.length),
    ),
  );

it("inventories RAW, FILL, DONT_CARE and CRC32 chunks and plans their expansion", () => {
  const bytes = mixedAndroidSparseImage();
  const parsed = parseAndroidSparseImage(bytes);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value).toMatchObject({
    header: {
      majorVersion: 1,
      minorVersion: 0,
      fileHeaderSize: 28,
      chunkHeaderSize: 12,
      blockSize: 4,
      totalBlocks: 4,
      totalChunks: 4,
      imageChecksum: 0x89abcdef,
    },
    expandedBytes: 16,
    counts: { raw: 1, fill: 1, dontCare: 1, crc32: 1 },
    coveredBytes: { raw: 4, fill: 8, dontCare: 4 },
    fillPatterns: ["aabbccdd"],
    crc32Chunks: [{ fileOffset: 72, value: 0x12345678 }],
    trailingBytes: 0,
    limitations: [
      ANDROID_SPARSE_IMAGE_LIMITATIONS.checksumUnverified,
      ANDROID_SPARSE_IMAGE_LIMITATIONS.dontCare,
    ],
  });
  const expanded = expand(bytes, parsed.value.runs);
  expect(expanded).toEqual(MIXED_ANDROID_SPARSE_EXPANDED);
  expect(createHash("sha256").update(expanded).digest("hex")).toBe(
    MIXED_ANDROID_SPARSE_SHA256,
  );
});

it("keeps larger header sizes and records their extra bytes as undecoded", () => {
  const parsed = parseAndroidSparseImage(
    buildAndroidSparseImage({
      blockSize: 4,
      minorVersion: 1,
      fileHeaderSize: 32,
      chunkHeaderSize: 16,
      chunks: [{ type: "raw", data: Buffer.from("WXYZ") }],
      trailing: Buffer.from([0xee, 0xee]),
    }),
  );
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value).toMatchObject({
    undecodedFileHeaderBytes: 4,
    undecodedFileHeaderHex: "cdcdcdcd",
    chunkHeaderExtraBytes: 4,
    trailingBytes: 2,
    runs: [{ kind: "raw", offset: 48, length: 4 }],
  });
  expect(parsed.value.limitations).toEqual([
    ANDROID_SPARSE_IMAGE_LIMITATIONS.checksumUnverified,
    "Minor version 1 is newer than 0; only the version 1.0 header and chunk fields were decoded.",
    ANDROID_SPARSE_IMAGE_LIMITATIONS.fileHeaderExtra,
    ANDROID_SPARSE_IMAGE_LIMITATIONS.chunkHeaderExtra,
    "2 bytes after the declared chunks were not decoded.",
  ]);
});

it("lists the first fill patterns and CRC32 chunks and counts the rest", () => {
  const count = ANDROID_SPARSE_LISTED_CHUNKS + 2;
  const parsed = parseAndroidSparseImage(
    buildAndroidSparseImage({
      blockSize: 4,
      chunks: Array.from({ length: count }, (_, index) => [
        {
          type: "fill" as const,
          blocks: 1,
          pattern: Buffer.from([index, 0, 0, 0]),
        },
        { type: "crc32" as const, value: index },
      ]).flat(),
    }),
  );
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.counts).toEqual({
    raw: 0,
    fill: count,
    dontCare: 0,
    crc32: count,
  });
  expect(parsed.value.fillPatterns).toHaveLength(ANDROID_SPARSE_LISTED_CHUNKS);
  expect(parsed.value.crc32Chunks).toHaveLength(ANDROID_SPARSE_LISTED_CHUNKS);
  expect(parsed.value.limitations).toEqual(
    expect.arrayContaining([
      `Fill patterns after the first ${String(ANDROID_SPARSE_LISTED_CHUNKS)} were counted and not listed.`,
      `CRC32 chunks after the first ${String(ANDROID_SPARSE_LISTED_CHUNKS)} were counted and not listed.`,
    ]),
  );
});

it.each([
  {
    label: "a chunk sum that does not reach total_blks",
    bytes: buildAndroidSparseImage({
      blockSize: 4,
      totalBlocks: 3,
      chunks: [{ type: "dont-care", blocks: 2 }],
    }),
    kind: "malformed",
    field: "total_blks",
  },
  {
    label: "an unknown chunk type",
    bytes: buildAndroidSparseImage({
      blockSize: 4,
      totalBlocks: 0,
      chunks: [{ type: 0xcac5 }],
    }),
    kind: "malformed",
    field: "chunk_type",
  },
  {
    label: "a zero block size",
    bytes: buildAndroidSparseImage({ blockSize: 0 }),
    kind: "malformed",
    field: "blk_sz",
  },
  {
    label: "a block size that is not a multiple of 4",
    bytes: buildAndroidSparseImage({ blockSize: 6 }),
    kind: "malformed",
    field: "blk_sz",
  },
  {
    label: "a truncated RAW chunk",
    bytes: buildAndroidSparseImage({
      blockSize: 4,
      chunks: [{ type: "raw", data: Buffer.from("ABCDEFGH") }],
    }).subarray(0, -1),
    kind: "truncated",
    field: "total_sz",
  },
  {
    label: "a RAW total_sz that disagrees with its block count",
    bytes: buildAndroidSparseImage({
      blockSize: 4,
      chunks: [
        { type: "raw", blocks: 2, data: Buffer.from("ABCD"), totalSize: 16 },
      ],
    }),
    kind: "malformed",
    field: "total_sz",
  },
  {
    label: "a CRC32 chunk that declares output blocks",
    bytes: buildAndroidSparseImage({
      blockSize: 4,
      chunks: [
        { type: "raw", data: Buffer.from("ABCD") },
        { type: "crc32", blocks: 1, value: 0x12345678 },
      ],
    }),
    kind: "malformed",
    field: "chunk_sz",
  },
  {
    label: "a truncated chunk header",
    // The CRC32 chunk header at offset 72 keeps 6 of its 12 bytes.
    bytes: mixedAndroidSparseImage().subarray(0, 78),
    kind: "truncated",
    field: "chunk_header",
  },
  {
    label: "a chunk header smaller than 12 bytes",
    bytes: buildAndroidSparseImage({ chunkHeaderSize: 8 }),
    kind: "malformed",
    field: "chunk_hdr_sz",
  },
  {
    label: "a truncated file header",
    bytes: mixedAndroidSparseImage().subarray(0, 20),
    kind: "truncated",
    field: "sparse_header",
  },
  {
    label: "major version 2 in a six-byte prefix",
    bytes: buildAndroidSparseImage({ majorVersion: 2 }).subarray(0, 6),
    kind: "unsupported",
    field: "major_version",
  },
  {
    label: "major version 2",
    bytes: buildAndroidSparseImage({ majorVersion: 2 }),
    kind: "unsupported",
    field: "major_version",
  },
])("fails $label with a structured parse failure", ({ bytes, kind, field }) => {
  const parsed = parseAndroidSparseImage(bytes);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.failure).toMatchObject({
    format: "android-sparse-image",
    kind,
    field,
  });
});

it("accumulates chunk facts one chunk at a time and checks the walked count", () => {
  const bytes = mixedAndroidSparseImage();
  const parsed = parseAndroidSparseHeader(bytes, bytes.length);
  if (!parsed.ok) throw parsed.error;
  const { header, undecoded } = parsed.value;
  const accumulator = new AndroidSparseImageAccumulator(header, undecoded);
  for (let index = 0; index < header.totalChunks; index += 1) {
    if (index === header.totalChunks - 1) {
      const short = accumulator.finish(bytes.length);
      expect(short.ok).toBe(false);
      if (!short.ok)
        expect(short.error.failure).toMatchObject({
          kind: "malformed",
          field: "total_chunks",
        });
    }
    const offset = accumulator.nextOffset;
    const chunk = parseAndroidSparseChunk(
      header,
      bytes.subarray(offset),
      offset,
      bytes.length,
      index,
    );
    if (!chunk.ok) throw chunk.error;
    accumulator.add(chunk.value);
  }
  const image = accumulator.finish(bytes.length);
  const whole = parseAndroidSparseImage(bytes);
  if (!image.ok || !whole.ok) throw new Error("sparse image did not parse");
  expect(image.value).toEqual(whole.value);
  expect(expand(bytes, image.value.runs)).toEqual(
    MIXED_ANDROID_SPARSE_EXPANDED,
  );
});

it("reports a chunk table that cannot fit in the file as truncated before walking", () => {
  const parsed = parseAndroidSparseImage(
    buildAndroidSparseImage({ totalChunks: 1_048_577 }),
  );
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.failure).toMatchObject({
    kind: "truncated",
    field: "total_chunks",
    offset: 20,
  });
});

it("parses more than 1,048,576 valid chunks without a fixed chunk ceiling", () => {
  const count = 1_048_577;
  const parsed = parseAndroidSparseImage(oneBlockFillAndroidSparseImage(count));
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.header.totalChunks).toBe(count);
  expect(parsed.value.expandedBytes).toBe(4 * count);
  expect(parsed.value.counts.fill).toBe(count);
});

it("parses the fixed header from 28 bytes when file_hdr_sz is larger", () => {
  const bytes = buildAndroidSparseImage({ fileHeaderSize: 40 });
  const parsed = parseAndroidSparseFileHeader(
    bytes.subarray(0, 28),
    bytes.length,
  );
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.fileHeaderSize).toBe(40);
  expect(
    parseAndroidSparseHeader(bytes.subarray(0, 28), bytes.length),
  ).toMatchObject({
    ok: false,
    error: { failure: { kind: "truncated", field: "file_hdr_sz" } },
  });
});

it("recognizes version 1 and refuses other major versions by magic", () => {
  expect(recognizeAndroidSparseImage(mixedAndroidSparseImage())).toEqual({
    state: "recognized",
  });
  expect(
    recognizeAndroidSparseImage(buildAndroidSparseImage({ majorVersion: 2 })),
  ).toEqual({ state: "refused", reason: androidSparseUnsupportedMajor(2) });
  expect(recognizeAndroidSparseImage(Buffer.from("ANDROID!"))).toBeUndefined();
});

it("reports omitted extension bytes alongside the bounded hex preview", () => {
  const parsed = parseAndroidSparseImage(
    buildAndroidSparseImage({ fileHeaderSize: 95 }),
  );
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.undecodedFileHeaderHex).toBe("cd".repeat(64));
  expect(parsed.value.limitations).toContain(
    "The hex preview shows the first 64 extension bytes and omits 3 bytes.",
  );
});

it("accepts a DONT_CARE run whose expanded size fits the byte representation", () => {
  const parsed = parseAndroidSparseImage(
    buildAndroidSparseImage({
      blockSize: 134217724,
      chunks: [{ type: "dont-care", blocks: 67108866 }],
    }),
  );
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.expandedBytes).toBe(2 ** 53 - 8);
});
