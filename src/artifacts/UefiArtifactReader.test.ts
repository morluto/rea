import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";

import {
  buildFfsFile,
  buildFv,
  buildImage,
} from "../../tests/fixtures/uefiImage.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { ArtifactEntry } from "./ArtifactReader.js";
import { UefiArtifactReader } from "./UefiArtifactReader.js";

const DRIVER_GUID = "9e21fd93-9c72-4c15-8c4b-e77f9db8d4d2";

/** Erased lead-in, one block-aligned volume, one payload FFS file. */
const buildReaderImage = (): Buffer => {
  const payloadFile = buildFfsFile({
    guid: DRIVER_GUID,
    typeCode: 0x07,
    payload: Buffer.from("driver bytes", "ascii"),
  });
  const volume = buildFv({ files: [payloadFile] });
  return Buffer.concat([
    Buffer.alloc(0x1000, 0xff),
    buildImage({ volumes: [volume.buffer] }),
  ]);
};

const openReader = async (image: Buffer): Promise<UefiArtifactReader> => {
  const root = await createTestTempDirectory("rea-uefi-reader-");
  const path = join(root, "image.FIb");
  await writeFile(path, image);
  return new UefiArtifactReader(path);
};

const collectEntries = async (
  reader: UefiArtifactReader,
  onOmission?: (path: string) => void,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries(
    undefined,
    onOmission === undefined
      ? {}
      : { onOmission: ({ path }: { path: string }) => onOmission(path) },
  )) {
    entries.push(entry);
  }
  return entries;
};

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe("UefiArtifactReader", () => {
  it("maps an erased lead-in, one volume directory, and its FFS file entries", async () => {
    const reader = await openReader(buildReaderImage());
    const omissions: string[] = [];
    const entries = await collectEntries(reader, (path) =>
      omissions.push(path),
    );
    expect(omissions).toEqual([]);
    expect(entries.map((entry) => [entry.path, entry.kind])).toEqual([
      ["firmware-volume-0x1000", "directory"],
      [`firmware-volume-0x1000/ffs-file-${DRIVER_GUID}.bin`, "file"],
    ]);
    const volume = entries[0];
    if (volume === undefined) throw new Error("reader produced no volume");
    const file = entries.at(1);
    expect(volume).toMatchObject({
      declaredSize: 0x1000,
      byteOffset: 0x1000,
    });
    expect(volume.limitations.at(0)).toContain("PI firmware file system 2");
    expect(file).toMatchObject({
      declaredSize: 24 + "driver bytes".length,
      byteOffset: 0x1048,
      executable: false,
      encrypted: false,
    });
    await reader.close();
  });

  it("opens an FFS entry and yields exactly its mapped bytes", async () => {
    const image = buildReaderImage();
    const reader = await openReader(image);
    const file = (await collectEntries(reader)).find(
      (entry) => entry.kind === "file",
    );
    if (file === undefined) throw new Error("reader produced no FFS entry");
    const bytes = await readAll(await reader.open(file));
    expect(bytes).toEqual(image.subarray(0x1048, 0x1048 + 24 + 12));
    await reader.close();
  });

  it("retries an unconfirmed descriptor close while keeping reader admission closed", async () => {
    const reader = await openReader(buildReaderImage());
    await collectEntries(reader);

    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockRejectedValueOnce(new Error("transient descriptor close failure"));
    try {
      await expect(reader.close()).rejects.toMatchObject({
        cleanup: {
          reason: expect.stringContaining("transient descriptor close failure"),
        },
      });
      await expect(collectEntries(reader)).rejects.toThrow("reader is closed");
      await expect(reader.close()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(2);
      const owner = close.mock.instances[1];
      if (!(owner instanceof OwnedFileHandle))
        throw new Error("close lost descriptor ownership");
      expect(owner.handle.fd).toBe(-1);
    } finally {
      close.mockRestore();
      await reader.close();
    }
  });

  it("refuses entries that were not produced by this reader", async () => {
    const reader = await openReader(buildReaderImage());
    const entries = await collectEntries(reader);
    const file = entries.find((entry) => entry.kind === "file");
    if (file === undefined) throw new Error("reader produced no FFS entry");
    await expect(reader.open({ ...file, declaredSize: 4096 })).rejects.toThrow(
      /does not match this reader's inventory/u,
    );
    await reader.close();
  });
});
