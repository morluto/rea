import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { expect, it } from "vitest";
import { AndroidSparseImageArtifactReader } from "./AndroidSparseImageArtifactReader.js";
import {
  ANDROID_SPARSE_CHUNK_TYPE_RAW,
  ANDROID_SPARSE_HEADER_SIZE,
  ANDROID_SPARSE_MAGIC,
} from "../domain/androidSparseImageFormat.js";
import { buildAndroidSparseImage } from "../../tests/fixtures/androidSparseImage.js";
import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const dir = await createTestTempDirectory("rea-android-sparse-");
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
};

it("classifies little-endian Android sparse headers without trusting filenames", async () => {
  const bytes = buildAndroidSparseImage({
    chunks: [{ kind: "dont_care", blocks: 4 }],
  });
  const path = await writeCarrier("opaque-blob.dat", bytes);
  expect(await classifyArtifactBytesAtPath(path, bytes)).toEqual({
    kind: "container",
    format: "android-sparse-image",
  });
});

it("streams physical RAW chunks via positional carrier offsets and leaves virtual FILL/DONT_CARE unmaterialized", async () => {
  const rawPayload = Buffer.alloc(4096, 0x33);
  rawPayload.write("SPARSE_RAW_PAYLOAD_SLICE", 64, "utf8");
  const bytes = buildAndroidSparseImage({
    minorVersion: 1,
    imageChecksum: 0xabcdef01,
    chunks: [
      { kind: "fill", blocks: 262_144, pattern: 0x01020304 }, // 1 GiB virtual fill
      { kind: "raw", data: rawPayload },
      { kind: "dont_care", blocks: 524_288 }, // 2 GiB virtual dont_care
      { kind: "crc32", crc32: 0x55667788 },
    ],
  });
  const carrierPath = await writeCarrier("vendor.img", bytes);
  const reader = new AndroidSparseImageArtifactReader(carrierPath);

  const discovered: Array<{ path: string; bytes: Buffer }> = [];
  try {
    for await (const entry of reader.entries()) {
      expect(entry.kind).toBe("file");
      expect(entry.formatMetadata).toMatchObject({
        kind: "android-sparse-chunk",
        chunk_index: 1,
        chunk_type: ANDROID_SPARSE_CHUNK_TYPE_RAW,
        output_block_offset: 262_144,
        output_byte_offset: 262_144 * 4096,
        output_blocks: 1,
        output_bytes: 4096,
      });
      discovered.push({
        path: entry.path,
        bytes: await collect(await reader.open(entry)),
      });
    }
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.path).toBe("chunks/chunk-0001-raw.bin");
    expect(discovered[0]!.bytes.equals(rawPayload)).toBe(true);
    expect(reader.formatMetadata()).toMatchObject({
      kind: "android-sparse-image",
      magic: ANDROID_SPARSE_MAGIC,
      major_version: 1,
      minor_version: 1,
      file_header_size: ANDROID_SPARSE_HEADER_SIZE,
      block_size: 4096,
      total_blocks: 262_144 + 1 + 524_288,
      total_chunks: 4,
      image_checksum: 0xabcdef01,
      unsparsed_size: (262_144 + 1 + 524_288) * 4096,
      raw_chunk_count: 1,
      fill_chunk_count: 1,
      dont_care_chunk_count: 1,
      crc32_chunk_count: 1,
      virtual_fill_bytes: 262_144 * 4096,
      virtual_dont_care_bytes: 524_288 * 4096,
      crc32_verified: false,
      crc32_chunk_values: [0x55667788],
    });
  } finally {
    await reader.close();
  }

  const snapshot = await scanCanonicalArtifactInventory(carrierPath);
  expect(snapshot.manifest.root_format).toBe("android-sparse-image");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.nodes).toContainEqual(
    expect.objectContaining({
      sha256: createHash("sha256").update(rawPayload).digest("hex"),
      size: 4096,
    }),
  );
  expect(snapshot.occurrences).toContainEqual(
    expect.objectContaining({
      logical_path: "chunks/chunk-0001-raw.bin",
      source_location: {
        offset: ANDROID_SPARSE_HEADER_SIZE + 16 + 12,
        length: 4096,
      },
      format_metadata: expect.objectContaining({
        kind: "android-sparse-chunk",
        chunk_index: 1,
      }),
    }),
  );
});

it("handles a 0-raw-chunk sparse image (virtual blocks only) without failing inventory", async () => {
  const bytes = buildAndroidSparseImage({
    chunks: [
      { kind: "dont_care", blocks: 65_536 },
      { kind: "fill", blocks: 65_536, pattern: 0 },
    ],
  });
  const path = await writeCarrier("sparse-virtual-only.img", bytes);
  const snapshot = await scanCanonicalArtifactInventory(path);

  expect(snapshot.manifest.root_format).toBe("android-sparse-image");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.occurrences).toHaveLength(1);
  expect(snapshot.occurrences[0]!.format_metadata).toMatchObject({
    kind: "android-sparse-image",
    raw_chunk_count: 0,
    fill_chunk_count: 1,
    dont_care_chunk_count: 1,
    unsparsed_size: 131_072 * 4096,
  });
});

it("reports unknown coverage when unparsed trailing bytes follow declared chunks", async () => {
  const bytes = buildAndroidSparseImage({
    chunks: [{ kind: "dont_care", blocks: 2 }],
    trailingBytes: Buffer.from("AVB0_TRAILING_PAD"),
  });
  const path = await writeCarrier("sparse-trailing.img", bytes);
  const snapshot = await scanCanonicalArtifactInventory(path);

  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.occurrences[0]!.format_metadata).toMatchObject({
    kind: "android-sparse-image",
    trailing_bytes: "AVB0_TRAILING_PAD".length,
  });
});
