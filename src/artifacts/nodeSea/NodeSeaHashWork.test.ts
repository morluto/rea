import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { nodeSeaMachO } from "./NodeSea.fixture.js";
import { nodeSeaOverlappingMachO } from "../../../tests/fixtures/nodeSeaOverlapping.js";
import { locateNodeSea } from "./NodeSeaLocation.js";

it("bounds verification of distinct overlapping SEA declarations by carrier bytes", async () => {
  const { bytes: image, payloadAt } = nodeSeaOverlappingMachO();
  const root = await createTestTempDirectory("rea-sea-hash-work-");
  const path = join(root, "carrier");
  await writeFile(path, image);
  const handle = await open(path, "r");
  const read = handle.read.bind(handle);
  let hashBytes = 0;
  vi.spyOn(handle, "read").mockImplementation((async (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    const result = await read(buffer, offset, length, position);
    hashBytes += Math.max(
      0,
      Math.min(position + result.bytesRead, image.length) -
        Math.max(position, payloadAt),
    );
    return result;
  }) as typeof handle.read);
  try {
    let failure: unknown;
    try {
      await locateNodeSea(handle, image.length);
    } catch (cause) {
      failure = cause;
    }
    expect(hashBytes).toBeLessThanOrEqual(image.length);
    expect(failure).toMatchObject({ reason: "limit" });
  } finally {
    await handle.close();
  }
});

it.each(["exact aliases", "disjoint copies"] as const)(
  "still accepts identical SEA bytes in %s",
  async (kind) => {
    const blob = Buffer.alloc(16 * 1024);
    const image =
      kind === "exact aliases"
        ? nodeSeaOverlappingMachO(true).bytes
        : nodeSeaMachO({ blob, extraBlobs: [blob] });
    const root = await createTestTempDirectory("rea-sea-hash-control-");
    const path = join(root, "carrier");
    await writeFile(path, image);
    const handle = await open(path, "r");
    try {
      await expect(locateNodeSea(handle, image.length)).resolves.toMatchObject({
        carrier: "mach-o",
        blobLength: blob.length,
      });
    } finally {
      await handle.close();
    }
  },
);

it("rejects unequal blob lengths before hashing either copy", async () => {
  const image = nodeSeaMachO({
    blob: Buffer.alloc(16 * 1024),
    extraBlobs: [Buffer.alloc(16 * 1024 + 1)],
  });
  const root = await createTestTempDirectory("rea-sea-hash-lengths-");
  const path = join(root, "carrier");
  await writeFile(path, image);
  const handle = await open(path, "r");
  const read = handle.read.bind(handle);
  let payloadReads = 0;
  vi.spyOn(handle, "read").mockImplementation((async (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    if (length >= 16 * 1024) payloadReads++;
    return read(buffer, offset, length, position);
  }) as typeof handle.read);
  try {
    await expect(locateNodeSea(handle, image.length)).rejects.toMatchObject({
      reason: "format",
    });
    expect(payloadReads).toBe(0);
  } finally {
    await handle.close();
  }
});
