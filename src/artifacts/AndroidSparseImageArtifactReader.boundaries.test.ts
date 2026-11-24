import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AndroidSparseImageArtifactReader } from "./AndroidSparseImageArtifactReader.js";
import {
  DEFAULT_ANDROID_SPARSE_READER_LIMITS,
  resolveArtifactReaderLimits,
} from "../domain/artifactReaderLimits.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import { collectEntries } from "../../tests/fixtures/artifactEntries.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import {
  artifactPreparationRecoveryCases,
  artifactReaderLifecycleCases,
} from "../../tests/fixtures/artifactReaderLifecycle.js";
import { buildAndroidSparseImage } from "../../tests/fixtures/androidSparseImage.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const validImage = (): Buffer =>
  buildAndroidSparseImage({
    chunks: [
      { kind: "raw", data: Buffer.alloc(4096, 0x22) },
      { kind: "dont_care", blocks: 10 },
    ],
  });

const openReaders: AndroidSparseImageArtifactReader[] = [];
const trackReader = (
  reader: AndroidSparseImageArtifactReader,
): AndroidSparseImageArtifactReader => {
  openReaders.push(reader);
  return reader;
};

afterEach(async () => {
  while (openReaders.length > 0) {
    const reader = openReaders.pop()!;
    await reader.close();
  }
});

artifactReaderLifecycleCases({
  image: validImage,
  createReader: (path, admitted) =>
    new AndroidSparseImageArtifactReader(path, admitted),
});

artifactPreparationRecoveryCases({
  image: validImage,
  createReader: (path, admitted) =>
    new AndroidSparseImageArtifactReader(path, admitted),
});

it("enforces adjustable artifact_limits.android_sparse.chunk_count and recovers when raised", async () => {
  const dir = await createTestTempDirectory("rea-android-sparse-limits-");
  const path = join(dir, "three-chunks.img");
  await writeFile(
    path,
    buildAndroidSparseImage({
      chunks: [
        { kind: "dont_care", blocks: 1 },
        { kind: "fill", blocks: 2, pattern: 0x01020304 },
        { kind: "raw", data: Buffer.alloc(4096, 0x44) },
      ],
    }),
  );

  const constrained = trackReader(
    new AndroidSparseImageArtifactReader(path, undefined, { chunk_count: 2 }),
  );
  let failure: unknown;
  try {
    await collectEntries(constrained);
  } catch (error: unknown) {
    failure = error;
  } finally {
    await constrained.close();
  }

  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  expect(failure).toMatchObject({
    reason: "limit",
    boundary: "capacity",
    readerLimit: {
      parameter: "artifact_limits.android_sparse.chunk_count",
      effective_value: 2,
      required_value: 3,
      unit: "count",
      can_increase: true,
    },
  });

  const raisedLimits = resolveArtifactReaderLimits({
    android_sparse: { chunk_count: 3 },
  });
  expect(raisedLimits.android_sparse).toEqual({
    ...DEFAULT_ANDROID_SPARSE_READER_LIMITS,
    chunk_count: 3,
  });
  const snapshot = await scanCanonicalArtifactInventory(path, {
    readerLimits: raisedLimits,
  });
  expect(snapshot.manifest.root_format).toBe("android-sparse-image");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.occurrences[0]!.format_metadata).toMatchObject({
    kind: "android-sparse-image",
    total_chunks: 3,
  });
});

it("admits extended file_hdr_sz and chunk_hdr_sz up to intrinsic uint16 and file bounds", async () => {
  const dir = await createTestTempDirectory("rea-android-sparse-ext-hdr-");
  const path = join(dir, "extended-headers.img");
  const rawSlice = Buffer.alloc(4096, 0x55);
  await writeFile(
    path,
    buildAndroidSparseImage({
      fileHdrSz: 8192,
      chunkHdrSz: 2048,
      chunks: [{ kind: "raw", data: rawSlice }],
    }),
  );

  const reader = trackReader(new AndroidSparseImageArtifactReader(path));
  try {
    const entries = await collectEntries(reader);
    expect(entries).toHaveLength(1);
    expect(reader.formatMetadata()).toMatchObject({
      kind: "android-sparse-image",
      file_header_size: 8192,
      chunk_header_size: 2048,
      raw_chunk_count: 1,
    });
  } finally {
    await reader.close();
  }
});

it("recomputes carrier identity checks cleanly if file changes after prepare", async () => {
  const dir = await createTestTempDirectory("rea-android-sparse-mutate-");
  const path = join(dir, "mutated.img");
  await writeFile(path, validImage());

  const reader = trackReader(new AndroidSparseImageArtifactReader(path));
  try {
    const entries = await collectEntries(reader);
    expect(entries).toHaveLength(1);

    await writeFile(
      path,
      buildAndroidSparseImage({
        chunks: [
          { kind: "raw", data: Buffer.alloc(4096, 0x99) },
          { kind: "dont_care", blocks: 10 },
        ],
      }),
    );

    await expect(reader.open(entries[0]!)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
});
