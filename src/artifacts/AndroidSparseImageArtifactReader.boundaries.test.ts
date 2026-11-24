import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AndroidSparseImageArtifactReader } from "./AndroidSparseImageArtifactReader.js";
import {
  ANDROID_SPARSE_MAX_CHUNK_HEADER_BYTES,
  ANDROID_SPARSE_MAX_CHUNKS,
  ANDROID_SPARSE_MAX_FILE_HEADER_BYTES,
} from "../domain/androidSparseImageFormat.js";
import {
  artifactFixedLimitFailure,
  ArtifactReaderFailure,
} from "../resources/index.js";
import { collectEntries } from "../../tests/fixtures/artifactEntries.js";
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

it("maps fixed chunk and header ceilings to structured capacity failures", async () => {
  const dir = await createTestTempDirectory("rea-android-sparse-limits-");

  const chunkLimitPath = join(dir, "too-many-chunks.img");
  await writeFile(
    chunkLimitPath,
    buildAndroidSparseImage({ totalChunks: ANDROID_SPARSE_MAX_CHUNKS + 1 }),
  );
  const chunkReader = new AndroidSparseImageArtifactReader(chunkLimitPath);
  const chunkFailure = await collectEntries(chunkReader).catch(
    (error: unknown) => error,
  );
  await chunkReader.close();
  expect(chunkFailure).toBeInstanceOf(ArtifactReaderFailure);
  expect(chunkFailure).toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: artifactFixedLimitFailure(
      {
        name: "Android sparse chunk count",
        kind: "parser",
        limit: ANDROID_SPARSE_MAX_CHUNKS,
        unit: "chunks",
      },
      "sparse limit",
      "capacity",
    ).fixedAllowance,
  });

  const fileHdrPath = join(dir, "huge-file-hdr.img");
  await writeFile(
    fileHdrPath,
    buildAndroidSparseImage({
      fileHdrSz: ANDROID_SPARSE_MAX_FILE_HEADER_BYTES + 1,
    }),
  );
  const fileHdrReader = new AndroidSparseImageArtifactReader(fileHdrPath);
  await expect(collectEntries(fileHdrReader)).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
  });
  await fileHdrReader.close();

  const chunkHdrPath = join(dir, "huge-chunk-hdr.img");
  const chunkHdrBytes = buildAndroidSparseImage();
  chunkHdrBytes.writeUInt16LE(ANDROID_SPARSE_MAX_CHUNK_HEADER_BYTES + 1, 10);
  await writeFile(chunkHdrPath, chunkHdrBytes);
  const chunkHdrReader = new AndroidSparseImageArtifactReader(chunkHdrPath);
  await expect(collectEntries(chunkHdrReader)).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
  });
  await chunkHdrReader.close();
});

it("recomputes carrier identity checks cleanly if file changes after prepare", async () => {
  const dir = await createTestTempDirectory("rea-android-sparse-mutate-");
  const path = join(dir, "mutated.img");
  await writeFile(path, validImage());

  const reader = new AndroidSparseImageArtifactReader(path);
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
  await reader.close();
});
