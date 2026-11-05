import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../ArtifactResourceScope.js";
import { scanArtifactInventoryForExtractionInScope } from "../inventory/ArtifactInventory.js";
import {
  isStableRegularFileDescriptor,
  materializeArtifactInventoryInScope,
  requireStableRegularFileDescriptor,
} from "./ArtifactExtraction.js";

it("accepts a descriptor with the members sameRegularFileState and revalidation read", () => {
  const descriptor = {
    handle: {
      read: () => undefined,
      stat: () => undefined,
    },
    initial: {
      size: 4,
      dev: 1,
      ino: 2,
      mode: 0o100644,
      mtimeMs: 3,
      ctimeMs: 4,
    },
  };
  expect(isStableRegularFileDescriptor(descriptor)).toBe(true);
  expect(
    requireStableRegularFileDescriptor("/tmp/source.zip", descriptor),
  ).toBe(descriptor);
});

it.each<unknown>([
  null,
  undefined,
  "zip",
  { handle: { read: (): undefined => undefined } },
  {
    handle: {
      read: (): undefined => undefined,
      stat: (): undefined => undefined,
    },
    initial: { size: 1 },
  },
])("rejects an unexpected transferred source shape", (value) => {
  expect(isStableRegularFileDescriptor(value)).toBe(false);
});

it("throws an integrity ArtifactReaderFailure from requireStableRegularFileDescriptor when given a non-file admission", () => {
  const admission: unknown = { kind: "node-sea" };
  expect(() =>
    requireStableRegularFileDescriptor("/tmp/source.zip", admission),
  ).toThrowError(
    expect.objectContaining({
      name: "ArtifactReaderFailure",
      reason: "integrity",
      message:
        "Transferred ZIP source is not a stable regular-file descriptor: /tmp/source.zip",
    }),
  );
});

it("revalidates a live transferred ZIP descriptor after inventory and fails closed when mutated", async () => {
  const directory = await createTestTempDirectory("rea-zip-source-guard-");
  const zipPath = join(directory, "source.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("hello.txt", new TextReader("original\n"));
  const initialBytes = Buffer.from(await writer.close());
  await writeFile(zipPath, initialBytes);

  const resourceScope = new ArtifactResourceScope();
  try {
    const { snapshot, transferredSource } =
      await scanArtifactInventoryForExtractionInScope(zipPath, {
        resourceScope,
        environment: {},
        integrity: "fail",
      });
    expect(transferredSource).toBeDefined();

    const rewrittenWriter = new ZipWriter(new Uint8ArrayWriter());
    await rewrittenWriter.add("hello.txt", new TextReader("original\n"));
    const rewrittenBytes = Buffer.concat([
      Buffer.from(await rewrittenWriter.close()),
      Buffer.from("trailing-mutation"),
    ]);
    await writeFile(zipPath, rewrittenBytes);

    const mutatedHandle = await open(zipPath, "r");
    try {
      const mutatedStats = await mutatedHandle.stat();
      await expect(
        materializeArtifactInventoryInScope(
          {
            inputPath: zipPath,
            inputFormat: "zip",
            outputRoot: join(directory, "dry-out"),
            dryRun: true,
            environment: {},
            integrityPolicy: "fail",
            resourceScope,
          },
          zipPath,
          snapshot,
          undefined,
          {
            owner: transferredSource!.owner,
            admission: {
              handle: mutatedHandle,
              initial: mutatedStats,
            },
            releaseAttempted: false,
          },
        ),
      ).rejects.toMatchObject({
        name: "ArtifactReaderFailure",
        reason: "integrity",
      });
    } finally {
      await mutatedHandle.close().catch(() => undefined);
    }
  } finally {
    await resourceScope.close();
  }
});
