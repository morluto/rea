import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import { ANDROID_SPARSE_IMAGE_LIMITATIONS } from "../domain/firmware/androidSparseImage.js";
import {
  MIXED_ANDROID_SPARSE_EXPANDED,
  MIXED_ANDROID_SPARSE_SHA256,
  buildAndroidSparseImage,
  mixedAndroidSparseImage,
} from "../domain/firmware/androidSparseImage.fixture.js";
import { zipArchive } from "../domain/desktop/zipArchive.fixture.js";
import { buildBootImage } from "../../tests/fixtures/androidBootImage.js";
import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

type Snapshot = Awaited<ReturnType<typeof scanCanonicalArtifactInventory>>;

const nodeAt = (snapshot: Snapshot, logicalPath: string) => {
  const occurrence = snapshot.occurrences.find(
    (row) => row.logical_path === logicalPath,
  );
  return snapshot.nodes.find(
    (node) => node.artifact_id === occurrence?.artifact_id,
  );
};

const writeCarrier = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-android-sparse-", name, bytes);

it("classifies sparse image bytes as a container by magic, not by suffix", () => {
  expect(
    classifyArtifactBytesAtPath("vendor.bin", mixedAndroidSparseImage()),
  ).toEqual({ kind: "container", format: "android-sparse-image" });
  expect(
    classifyArtifactBytesAtPath(
      "system.img",
      buildAndroidSparseImage({ majorVersion: 2 }),
    ),
  ).toEqual({ kind: "resource", format: "file" });
});

it("inventories header facts and chunk counts and hashes the expanded image", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("system.img", mixedAndroidSparseImage()),
  );
  expect(snapshot.manifest.root_format).toBe("android-sparse-image");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.limitations).toEqual(
    expect.arrayContaining([
      ANDROID_SPARSE_IMAGE_LIMITATIONS.inventoryScope,
      ANDROID_SPARSE_IMAGE_LIMITATIONS.checksumUnverified,
      ANDROID_SPARSE_IMAGE_LIMITATIONS.dontCare,
    ]),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    artifact_kind: "container",
    format_metadata: {
      kind: "android-sparse-image",
      magic: "0xed26ff3a",
      major_version: 1,
      minor_version: 0,
      block_size: 4,
      total_blocks: 4,
      total_chunks: 4,
      expanded_size: 16,
      image_checksum: 0x89abcdef,
      checksums_verified: false,
      chunk_counts: { raw: 1, fill: 1, dont_care: 1, crc32: 1 },
      covered_bytes: { raw: 4, fill: 8, dont_care: 4 },
      fill_patterns: ["aabbccdd"],
      crc32_chunks: [{ file_offset: 72, value: 0x12345678 }],
      trailing_bytes: 0,
    },
  });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "image.raw"),
  ).toMatchObject({
    declared_size: 16,
    hash_status: "verified",
    limitations: [ANDROID_SPARSE_IMAGE_LIMITATIONS.dontCare],
  });
  expect(nodeAt(snapshot, "image.raw")).toMatchObject({
    size: 16,
    sha256: MIXED_ANDROID_SPARSE_SHA256,
  });
});

it("extracts the expanded partition image", async () => {
  const path = await writeCarrier("system.img", mixedAndroidSparseImage());
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "android-sparse-image",
      outputRoot: join(path, "..", "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(extracted.containment_verified).toBe(true);
    const image = await readFile(join(extracted.output_root, "image.raw"));
    expect(image.equals(MIXED_ANDROID_SPARSE_EXPANDED)).toBe(true);
  } finally {
    await resourceScope.close();
  }
});

it("classifies an expanded boot image child as android-boot-image", async () => {
  const boot = buildBootImage({
    version: 2,
    kernel: Buffer.from("KERNEL"),
    ramdisk: Buffer.from("RAMDISK"),
  });
  const sparse = buildAndroidSparseImage({
    blockSize: 4,
    chunks: [{ type: "raw", data: boot }],
  });
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("boot.img", sparse),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "image.raw"),
  ).toMatchObject({
    artifact_kind: "container",
    artifact_format: "android-boot-image",
  });
  expect(nodeAt(snapshot, "image.raw")).toMatchObject({
    sha256: createHash("sha256").update(boot).digest("hex"),
  });
});

it("classifies a sparse image nested in a factory zip", async () => {
  const archive = zipArchive([
    { name: "system.img", data: mixedAndroidSparseImage(), method: 0 },
  ]);
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("factory.zip", archive),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "system.img"),
  ).toMatchObject({
    artifact_format: "android-sparse-image",
    artifact_kind: "container",
  });
});
