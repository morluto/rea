import { artifactPreparationRecoveryCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { AndroidSparseImageArtifactReader } from "./AndroidSparseImageArtifactReader.js";
import {
  ANDROID_SPARSE_CHUNK_HEADER_BYTES,
  ANDROID_SPARSE_FILE_HEADER_BYTES,
  ANDROID_SPARSE_LISTED_CHUNKS,
} from "../domain/firmware/androidSparseImage.js";
import {
  buildAndroidSparseImage,
  expandAndroidSparseChunks,
  mixedAndroidSparseChunks,
  mixedAndroidSparseImage,
  oneBlockFillAndroidSparseImage,
  type AndroidSparseChunkSpec,
} from "../domain/firmware/androidSparseImage.fixture.js";

const fixture = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-android-sparse-boundary-"),
    "system.img",
  );
  await writeFile(path, bytes);
  return path;
};

const entries = async (reader: AndroidSparseImageArtifactReader) => {
  const result = [];
  for await (const entry of reader.entries()) result.push(entry);
  return result;
};

it("reads only chunk headers once RAW payloads move past the window", async () => {
  const blockSize = 64 * 1024;
  const chunks = Array.from({ length: 16 }, () => ({
    type: "raw" as const,
    data: Buffer.alloc(blockSize),
  }));
  const path = await fixture(buildAndroidSparseImage({ blockSize, chunks }));
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidSparseImageArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    expect(await entries(reader)).toHaveLength(1);
    const ranges = reads.mock.calls.map((call) => {
      const [, , length, position] = call as unknown as [
        Buffer,
        number,
        number,
        number,
      ];
      return { position, length };
    });
    const chunkStride = ANDROID_SPARSE_CHUNK_HEADER_BYTES + blockSize;
    // The file header read and the first chunk window, then one
    // header-sized read per later chunk: no RAW payload is read again.
    expect(ranges.slice(2)).toEqual(
      Array.from({ length: chunks.length - 1 }, (_, index) => ({
        position: ANDROID_SPARSE_FILE_HEADER_BYTES + (index + 1) * chunkStride,
        length: ANDROID_SPARSE_CHUNK_HEADER_BYTES + 4,
      })),
    );
  } finally {
    reads.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

const readRanges = (reads: { mock: { calls: unknown[][] } }) =>
  reads.mock.calls.map((call) => {
    const [, , length, position] = call as [
      Buffer,
      number,
      number,
      number | bigint,
    ];
    return { position: Number(position), length };
  });

/** Where a chunk's payload starts, from the fixture's default header sizes. */
const payloadOffset = (
  chunks: readonly AndroidSparseChunkSpec[],
  index: number,
): number =>
  chunks
    .slice(0, index)
    .reduce(
      (offset, chunk) =>
        offset +
        ANDROID_SPARSE_CHUNK_HEADER_BYTES +
        (chunk.type === "raw"
          ? (chunk.data?.length ?? 0)
          : chunk.type === "dont-care"
            ? 0
            : 4),
      ANDROID_SPARSE_FILE_HEADER_BYTES,
    ) + ANDROID_SPARSE_CHUNK_HEADER_BYTES;

const WINDOW_BYTES = 64 * 1024;

it("walks many small RAW chunks through a bounded number of window reads", async () => {
  // 8-byte payloads leave a gap after the first window, which must not
  // degrade the walk to one header-sized read per chunk.
  const chunks = Array.from({ length: 20_000 }, (_, index) => ({
    type: "raw" as const,
    data: Buffer.alloc(8, index),
  }));
  const image = buildAndroidSparseImage({ blockSize: 4, chunks });
  const path = await fixture(image);
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidSparseImageArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    expect(await entries(reader)).toHaveLength(1);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil(image.length / (WINDOW_BYTES - 32)) + 1,
    );
  } finally {
    reads.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

it("expands many tiny RAW runs through bounded reads and streams a large run directly", async () => {
  const blockSize = 4;
  const largeRaw = Buffer.alloc(4 * WINDOW_BYTES);
  for (let index = 0; index < largeRaw.length; index += 1)
    largeRaw[index] = (index * 7) & 0xff;
  const tiny = (count: number, seed: number): AndroidSparseChunkSpec[] =>
    Array.from({ length: count }, (_, index): AndroidSparseChunkSpec => {
      if (index % 11 === 10) return { type: "dont-care", blocks: 2 };
      if (index % 7 === 6)
        return {
          type: "fill",
          blocks: 3,
          pattern: Buffer.from([seed, index & 0xff, 0x5a, 0xa5]),
        };
      if (index % 97 === 96) return { type: "crc32", value: index };
      // Payloads of 4 to 40 bytes put runs across every window boundary.
      const data = Buffer.alloc(4 * (1 + (index % 10)));
      data.writeUInt32LE((seed << 24) | index, 0);
      return { type: "raw", data };
    });
  const chunks: AndroidSparseChunkSpec[] = [
    ...tiny(4_000, 1),
    // Exactly the small-payload size: still served by the window.
    { type: "raw", data: Buffer.alloc(16 * 1024, 0x3c) },
    ...tiny(1_000, 2),
    { type: "raw", data: largeRaw },
    ...tiny(4_000, 3),
  ];
  const largeIndex = 5_001;
  const image = buildAndroidSparseImage({ blockSize, chunks });
  const path = await fixture(image);
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidSparseImageArtifactReader(path, admitted);
  try {
    const [entry] = await entries(reader);
    const reads = vi.spyOn(admitted.handle, "read");
    try {
      const expanded = await buffer(await reader.open(entry!));
      expect(
        expanded.equals(expandAndroidSparseChunks(blockSize, chunks)),
      ).toBe(true);
      const ranges = readRanges(reads);
      const largeStart = payloadOffset(chunks, largeIndex);
      const largeEnd = largeStart + largeRaw.length;
      // The large run streams in positional reads of its own range.
      expect(
        ranges.filter(
          ({ position }) => position >= largeStart && position < largeEnd,
        ),
      ).toEqual(
        Array.from({ length: 4 }, (_, index) => ({
          position: largeStart + index * WINDOW_BYTES,
          length: WINDOW_BYTES,
        })),
      );
      // Over 7,000 small RAW runs share a handful of window reads.
      const smallBytes = image.length - largeRaw.length;
      expect(ranges.length - 4).toBeLessThanOrEqual(
        Math.ceil(smallBytes / (WINDOW_BYTES - 16 * 1024)) + 2,
      );
    } finally {
      reads.mockRestore();
    }
  } finally {
    await reader.close();
    await admitted.handle.close();
  }
});

it.each([
  { fileHeaderSize: 28, ranges: [{ position: 0, length: 28 }] },
  {
    fileHeaderSize: 40,
    ranges: [
      { position: 0, length: 28 },
      { position: 28, length: 12 },
    ],
  },
])(
  "refuses an expansion above the reader allowance after reading only the $fileHeaderSize-byte header",
  async ({ fileHeaderSize, ranges }) => {
    const path = await fixture(
      buildAndroidSparseImage({
        blockSize: 4,
        fileHeaderSize,
        chunks: [{ type: "dont-care", blocks: 4 }],
      }),
    );
    const admitted = await openRegularFile(path, { symlinks: "reject" });
    const reader = new AndroidSparseImageArtifactReader(
      path,
      admitted,
      undefined,
      15,
    );
    const reads = vi.spyOn(admitted.handle, "read");
    try {
      await expect(entries(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
        readerLimit: {
          parameter: "artifact_limits.expanded_bytes",
          effective_value: 15,
          required_value: 16,
        },
      });
      // The fixed header, then only its declared extension; no chunk header.
      expect(readRanges(reads)).toEqual(ranges);
    } finally {
      reads.mockRestore();
      await reader.close();
      await admitted.handle.close();
    }
  },
);

it("starts the chunk window after the header so no header byte is read twice", async () => {
  const path = await fixture(
    buildAndroidSparseImage({
      blockSize: 4,
      fileHeaderSize: 96,
      chunks: mixedAndroidSparseChunks(),
    }),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidSparseImageArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    expect(await entries(reader)).toHaveLength(1);
    const ranges = readRanges(reads);
    expect(ranges.slice(0, 2)).toEqual([
      { position: 0, length: 28 },
      { position: 28, length: 68 },
    ]);
    expect(ranges[2]?.position).toBe(96);
    for (const [index, range] of ranges.entries())
      for (const earlier of ranges.slice(0, index))
        expect(
          range.position >= earlier.position + earlier.length ||
            range.position + range.length <= earlier.position,
        ).toBe(true);
  } finally {
    reads.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

it("refuses a declared chunk count above the selected budget before walking chunks", async () => {
  const path = await fixture(mixedAndroidSparseImage());
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidSparseImageArtifactReader(path, admitted, {
    chunk_count: 3,
  });
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
      readerLimit: {
        parameter: "artifact_limits.android_sparse_image.chunk_count",
        effective_value: 3,
        unit: "count",
        required_value: 4,
        can_increase: true,
        update_mode: "parameter",
      },
    });
    expect(readRanges(reads)).toEqual([{ position: 0, length: 28 }]);
  } finally {
    reads.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

it("admits more than 1,048,576 valid chunks once the chunk budget is raised", async () => {
  const count = 1_048_577;
  const path = await fixture(oneBlockFillAndroidSparseImage(count));
  const refused = new AndroidSparseImageArtifactReader(
    path,
    undefined,
    undefined,
    Number.MAX_SAFE_INTEGER,
  );
  try {
    // Raising expanded_bytes alone does not admit the chunk table.
    await expect(entries(refused)).rejects.toMatchObject({
      reason: "limit",
      readerLimit: {
        parameter: "artifact_limits.android_sparse_image.chunk_count",
        effective_value: 1_048_576,
        required_value: count,
        can_increase: true,
      },
    });
  } finally {
    await refused.close();
  }
  const admitted = new AndroidSparseImageArtifactReader(path, undefined, {
    chunk_count: count,
  });
  try {
    expect(await entries(admitted)).toMatchObject([
      { path: "image.raw", declaredSize: 4 * count },
    ]);
    expect(admitted.formatMetadata()).toMatchObject({
      total_chunks: count,
      chunk_counts: { fill: count },
    });
  } finally {
    await admitted.close();
  }
});

it("refuses major version 2 as unsupported rather than as a container", async () => {
  const reader = new AndroidSparseImageArtifactReader(
    await fixture(buildAndroidSparseImage({ majorVersion: 2 })),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "unsupported",
    });
  } finally {
    await reader.close();
  }
});

it("rejects a CRC32 chunk that declares output blocks", async () => {
  const reader = new AndroidSparseImageArtifactReader(
    await fixture(
      buildAndroidSparseImage({
        blockSize: 4,
        chunks: [
          { type: "raw", data: Buffer.from("ABCD") },
          { type: "crc32", blocks: 1, value: 0x12345678 },
        ],
      }),
    ),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "malformed",
      cause: { failure: { kind: "malformed", field: "chunk_sz", offset: 48 } },
    });
  } finally {
    await reader.close();
  }
});

it("accumulates a long CRC32 chunk table across walk yields", async () => {
  const crc32Count = 600;
  const reader = new AndroidSparseImageArtifactReader(
    await fixture(
      buildAndroidSparseImage({
        blockSize: 4,
        chunks: [
          { type: "raw", data: Buffer.from("ABCD") },
          ...Array.from({ length: crc32Count }, (_, value) => ({
            type: "crc32" as const,
            value,
          })),
        ],
      }),
    ),
  );
  try {
    const [entry] = await entries(reader);
    expect(reader.formatMetadata()).toMatchObject({
      total_chunks: crc32Count + 1,
      chunk_counts: { raw: 1, fill: 0, dont_care: 0, crc32: crc32Count },
      covered_bytes: { raw: 4, fill: 0, dont_care: 0 },
      trailing_bytes: 0,
    });
    expect(reader.formatMetadata()?.crc32_chunks).toHaveLength(
      ANDROID_SPARSE_LISTED_CHUNKS,
    );
    expect(
      (await buffer(await reader.open(entry!))).equals(Buffer.from("ABCD")),
    ).toBe(true);
  } finally {
    await reader.close();
  }
});

it("fails a truncated RAW chunk as a structured truncation", async () => {
  const reader = new AndroidSparseImageArtifactReader(
    await fixture(
      buildAndroidSparseImage({
        blockSize: 4,
        chunks: [{ type: "raw", data: Buffer.from("ABCDEFGH") }],
      }).subarray(0, -1),
    ),
  );
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "truncated",
      cause: { failure: { kind: "truncated", field: "total_sz" } },
    });
  } finally {
    await reader.close();
  }
});

it("streams multi-slice FILL and DONT_CARE runs between RAW chunks", async () => {
  const blockSize = 4096;
  const chunks: AndroidSparseChunkSpec[] = [
    { type: "raw", data: Buffer.alloc(blockSize * 20, 0x5a) },
    {
      type: "fill",
      blocks: 300,
      pattern: Buffer.from([0x01, 0x02, 0x03, 0x04]),
    },
    { type: "dont-care", blocks: 260 },
    { type: "raw", data: Buffer.alloc(blockSize, 0xa5) },
  ];
  const reader = new AndroidSparseImageArtifactReader(
    await fixture(buildAndroidSparseImage({ blockSize, chunks })),
  );
  try {
    const [entry] = await entries(reader);
    const expanded = await buffer(await reader.open(entry!));
    expect(expanded.equals(expandAndroidSparseChunks(blockSize, chunks))).toBe(
      true,
    );
  } finally {
    await reader.close();
  }
});

it("cancels a long DONT_CARE expansion with the caller's reason", async () => {
  const reader = new AndroidSparseImageArtifactReader(
    await fixture(
      buildAndroidSparseImage({
        blockSize: 4096,
        chunks: [{ type: "dont-care", blocks: 4096 }],
      }),
    ),
  );
  const controller = new AbortController();
  const reason = new Error("stop sparse expansion");
  try {
    const [entry] = await entries(reader);
    const stream = await reader.open(entry!, controller.signal);
    stream.once("data", () => controller.abort(reason));
    await expect(buffer(stream)).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
  } finally {
    await reader.close();
  }
});

it.each([
  {
    name: "close",
    retire: async (
      reader: AndroidSparseImageArtifactReader,
      _controller: AbortController,
    ) => {
      await reader.close();
    },
    failure: { reason: "unavailable" },
  },
  {
    name: "caller cancellation",
    retire: (
      _reader: AndroidSparseImageArtifactReader,
      controller: AbortController,
    ) => {
      controller.abort(new Error("stop undrained expansion"));
      return Promise.resolve();
    },
    failure: { reason: "cancelled" },
  },
])(
  "retires an undrained expansion above the high-water mark on $name",
  { timeout: 5_000 },
  async ({ retire, failure }) => {
    // 1 MiB of DONT_CARE output stalls Readable.from under backpressure.
    const reader = new AndroidSparseImageArtifactReader(
      await fixture(
        buildAndroidSparseImage({
          blockSize: 4096,
          chunks: [{ type: "dont-care", blocks: 256 }],
        }),
      ),
    );
    const controller = new AbortController();
    let stream: Readable | undefined;
    try {
      const [entry] = await entries(reader);
      stream = await reader.open(entry!, controller.signal);
      await setImmediate();
      await setImmediate();
      expect(stream.readableLength).toBeGreaterThanOrEqual(
        stream.readableHighWaterMark,
      );
      const closed = new Promise<unknown>((resolve) => {
        stream!.once("close", () => resolve(stream!.errored));
      });
      await retire(reader, controller);
      expect(await closed).toMatchObject(failure);
      await reader.close();
    } finally {
      stream?.destroy();
      await reader.close();
    }
  },
);

it("refuses to open an entry it did not produce", async () => {
  const reader = new AndroidSparseImageArtifactReader(
    await fixture(mixedAndroidSparseImage()),
  );
  try {
    const [entry] = await entries(reader);
    await expect(
      reader.open({ ...entry!, declaredSize: 4 }),
    ).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "entry-metadata",
    });
  } finally {
    await reader.close();
  }
});

artifactPreparationRecoveryCases({
  image: () => mixedAndroidSparseImage(),
  createReader: (path, admitted) =>
    new AndroidSparseImageArtifactReader(path, admitted),
});
