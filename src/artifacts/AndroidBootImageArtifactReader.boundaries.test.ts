import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { expect, it, vi } from "vitest";

import { AndroidBootImageArtifactReader } from "./AndroidBootImageArtifactReader.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import {
  buildBootImage,
  buildVendorBootImage,
  declareVendorRamdiskCount,
} from "../../tests/fixtures/androidBootImage.js";
import { artifactReaderLifecycleCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const fixture = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-android-boot-boundary-"),
    "image",
  );
  await writeFile(path, bytes);
  return path;
};

const entries = async (reader: AndroidBootImageArtifactReader) => {
  const result = [];
  for await (const entry of reader.entries()) result.push(entry);
  return result;
};

it("preserves cancellation during header admission", async () => {
  const path = await fixture(buildBootImage({ version: 0 }));
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidBootImageArtifactReader(path, admitted);
  const controller = new AbortController();
  const reason = new Error("cancel header admission");
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  const reads = vi.spyOn(admitted.handle, "read").mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await Reflect.apply(nativeRead, admitted.handle, args);
    if (args[3] === 0) controller.abort(reason);
    return result;
  }) as typeof admitted.handle.read);
  try {
    await expect(
      (async () => {
        for await (const _entry of reader.entries(controller.signal)) {
          /* Exhaust the admitted operation. */
        }
      })(),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  } finally {
    await reader.close();
    reads.mockRestore();
    await admitted.handle.close();
  }
});

it("rejects an excessive vendor ramdisk count before reading the table", async () => {
  const path = await fixture(
    declareVendorRamdiskCount(buildVendorBootImage({ version: 4 }), 4097),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AndroidBootImageArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    await expect(entries(reader)).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
    });
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    await reader.close();
    reads.mockRestore();
    await admitted.handle.close();
  }
});

artifactReaderLifecycleCases({
  image: () => buildBootImage({ version: 0 }),
  createReader: (path, admitted) =>
    new AndroidBootImageArtifactReader(path, admitted),
});

it("rejects a source changed after its header was prepared", async () => {
  const bytes = buildBootImage({ version: 0 });
  const path = await fixture(bytes);
  const reader = new AndroidBootImageArtifactReader(path);
  try {
    const [entry] = await entries(reader);
    await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]));
    await expect(reader.open(entry!)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
});

it("checks a multi-chunk member and preserves read cancellation", async () => {
  const kernel = Buffer.alloc(128 * 1024, 0x61);
  const bytes = buildBootImage({
    version: 0,
    kernel,
    ramdisk: Buffer.alloc(0),
  });
  const reader = new AndroidBootImageArtifactReader(await fixture(bytes));
  try {
    const [entry] = await entries(reader);
    const controller = new AbortController();
    const reason = new Error("cancel member bytes");
    const stream = await reader.open(entry!, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(reason);
    await expect(iterator.next()).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    expect((await buffer(await reader.open(entry!))).equals(kernel)).toBe(true);
  } finally {
    await reader.close();
  }
});
