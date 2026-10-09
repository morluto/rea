import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { ZipArtifactReader } from "../../../src/artifacts/ZipArtifactReader.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";

it("bounds a requested metadata read without rejecting the underlying valid ZIP", async () => {
  const root = await createTestTempDirectory("rea-zip-metadata-budget-");
  const path = join(root, "large-directory.zip");
  const name = `${"a".repeat(8192)}.class`;
  await writeOrderedZip(path, [name]);
  const bounded = new ZipArtifactReader(path, "zip", 4096);
  const control = new ZipArtifactReader(path, "zip");
  const collect = async (reader: ZipArtifactReader): Promise<string[]> => {
    const names: string[] = [];
    for await (const entry of reader.entries()) names.push(entry.path);
    return names;
  };
  try {
    await expect(collect(bounded)).rejects.toMatchObject({
      reason: "limit",
      message: expect.stringContaining("4096-byte read budget"),
    });
    await expect(collect(control)).resolves.toEqual([name]);
  } finally {
    await Promise.all([bounded.close(), control.close()]);
  }
});

it("rejects overlapping ZIP member data ranges through artifact inventory", async () => {
  const root = await createTestTempDirectory("rea-zip-overlap-");
  const path = join(root, "overlap.zip");
  await writeOrderedZip(path, ["a.txt", "b.txt"]);
  const bytes = await readFile(path);
  const centralDirectorySignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const first = bytes.indexOf(centralDirectorySignature);
  const second = bytes.indexOf(centralDirectorySignature, first + 4);
  if (first < 0 || second <= first)
    throw new Error("Expected two ZIP central-directory entries");

  const firstLocalOffset = bytes.readUInt32LE(first + 42);
  const secondLocalOffset = bytes.readUInt32LE(second + 42);
  expect(secondLocalOffset).not.toBe(firstLocalOffset);
  bytes.writeUInt32LE(firstLocalOffset, second + 42);
  await writeFile(path, bytes);

  const target = await parseBinaryTarget(path);
  if (!target.ok) throw target.error;
  const result = await new ArtifactProvider()
    .createClient(target.value)
    .execute("inventory_artifact", {});

  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "ArtifactOperationError", reason: "io" },
  });
});

it("preserves encrypted-member and corrupt-CRC observations", async () => {
  const root = await createTestTempDirectory("rea-zip-integrity-");
  const encryptedPath = join(root, "encrypted.zip");
  const encryptedWriter = new ZipWriter(new Uint8ArrayWriter());
  await encryptedWriter.add("secret.txt", new TextReader("secret bytes"), {
    password: "fixture-password",
  });
  await writeFile(encryptedPath, await encryptedWriter.close());

  const encryptedTarget = await parseBinaryTarget(encryptedPath);
  if (!encryptedTarget.ok) throw encryptedTarget.error;
  const encryptedResult = await new ArtifactProvider()
    .createClient(encryptedTarget.value)
    .execute("inventory_artifact", {});
  if (!encryptedResult.ok) throw encryptedResult.error;
  const encryptedInventory = artifactInventoryResultSchema.parse(
    encryptedResult.value.result,
  );
  expect(encryptedInventory.occurrences).toContainEqual(
    expect.objectContaining({
      logical_path: "secret.txt",
      encrypted: true,
      hash_status: "unavailable",
    }),
  );
  // REA does not decrypt entries, so complete extraction is unsupported.
  const extractionRoot = join(root, "encrypted-output");
  expect(
    await new ArtifactProvider()
      .createClient(encryptedTarget.value)
      .execute("extract_artifact", { output_root: extractionRoot }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisUnsupportedTargetError",
      reason: expect.stringContaining("Archive entry secret.txt is encrypted"),
    },
  });
  await expect(readFile(extractionRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });

  const corruptPath = join(root, "corrupt-crc.zip");
  const corruptWriter = new ZipWriter(new Uint8ArrayWriter());
  await corruptWriter.add("data.txt", new TextReader("evidence\n"));
  await writeFile(corruptPath, await corruptWriter.close());
  const bytes = await readFile(corruptPath);
  const localFileHeaderSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const localHeader = bytes.indexOf(localFileHeaderSignature);
  if (localHeader < 0) throw new Error("Expected a ZIP local-file header");
  const dataOffset =
    localHeader +
    30 +
    bytes.readUInt16LE(localHeader + 26) +
    bytes.readUInt16LE(localHeader + 28);
  const firstByte = bytes[dataOffset];
  if (firstByte === undefined) throw new Error("Expected ZIP member bytes");
  bytes[dataOffset] = firstByte ^ 1;
  await writeFile(corruptPath, bytes);

  const corruptTarget = await parseBinaryTarget(corruptPath);
  if (!corruptTarget.ok) throw corruptTarget.error;
  const corruptResult = await new ArtifactProvider()
    .createClient(corruptTarget.value)
    .execute("inventory_artifact", {});
  expect(corruptResult).toMatchObject({
    ok: false,
    error: { _tag: "ArtifactOperationError", reason: "io" },
  });
});

it("rejects a truncated ZIP through artifact inventory", async () => {
  const root = await createTestTempDirectory("rea-zip-malformed-");
  const path = join(root, "truncated.zip");
  await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const target = await parseBinaryTarget(path);
  if (!target.ok) throw target.error;
  const result = await new ArtifactProvider()
    .createClient(target.value)
    .execute("inventory_artifact", {});

  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "ArtifactOperationError", reason: "io" },
  });
});
