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
import type {
  ArtifactEntry,
  ArtifactTraversalOptions,
} from "../resources/ArtifactReader.js";
import { FFS3_FILE_SYSTEM_GUID } from "./UefiGuid.js";
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
  options?: ArtifactTraversalOptions,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries(undefined, options)) {
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
    const entries = await collectEntries(reader, {
      onOmission: ({ path }) => omissions.push(path),
    });
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

it("bounds aggregate block-map retention and reports the unvisited volume", async () => {
  const volume = buildFv({ files: [], blockMapEntries: 8_000 }).buffer;
  const reader = await openReader(
    Buffer.concat(Array.from({ length: 13 }, () => volume)),
  );
  const onOmission = vi.fn();
  const onCoverage = vi.fn();
  try {
    const entries = await collectEntries(reader, { onOmission, onCoverage });
    expect(entries).toHaveLength(12);
    expect(onOmission).toHaveBeenCalledWith({
      path: "volume-scan-limit",
      kind: "unsupported",
    });
    expect(onCoverage).toHaveBeenCalledWith({
      status: "unknown",
      limitations: [expect.stringMatching(/structural record limit/i)],
    });
  } finally {
    await reader.close();
  }
});

it("retains a complete volume when a later declared volume extends past EOF", async () => {
  const first = buildFv({ files: [] }).buffer;
  const truncated = buildFv({ files: [] }).buffer.subarray(0, 1024);
  const reader = await openReader(Buffer.concat([first, truncated]));
  const onOmission = vi.fn();
  const onCoverage = vi.fn();
  try {
    const entries = await collectEntries(reader, { onOmission, onCoverage });
    expect(entries.map(({ path }) => path)).toEqual(["firmware-volume-0x0"]);
    expect(onOmission).toHaveBeenCalledWith({
      path: "firmware-volume-0x1000",
      kind: "unsupported",
    });
    expect(onCoverage).toHaveBeenCalledWith({
      status: "unknown",
      limitations: [expect.stringMatching(/0x1000.*4096.*1024/u)],
    });
  } finally {
    await reader.close();
  }
});

it("reports an unreadable extended FFS header after a valid file", async () => {
  const file = buildFfsFile({
    guid: DRIVER_GUID,
    typeCode: 0x07,
    payload: Buffer.alloc(3976),
  });
  // The aligned file ends at 0xfe8. This following LARGE_FILE header has
  // a complete compact prefix and no room for its eight-byte ExtendedSize.
  const tail = Buffer.alloc(24, 0);
  tail[19] = 0x01;
  const image = buildFv({ files: [file, tail] }).buffer;
  const reader = await openReader(image.subarray(0, 0x1000));
  const onOmission = vi.fn();
  const onCoverage = vi.fn();
  try {
    const entries = await collectEntries(reader, { onOmission, onCoverage });
    expect(entries.map(({ path }) => path)).toEqual([
      "firmware-volume-0x0",
      `firmware-volume-0x0/ffs-file-${DRIVER_GUID}.bin`,
    ]);
    expect(onOmission).toHaveBeenCalledWith({
      path: "firmware-volume-0x0/ffs-suffix-0xfe8",
      kind: "unsupported",
    });
    expect(onCoverage).toHaveBeenCalledWith({
      status: "unknown",
      limitations: [expect.stringMatching(/0xfe8.*24/u)],
    });
  } finally {
    await reader.close();
  }
});

it("retains the readable prefix of a truncated FFS body and reports unknown coverage", async () => {
  const file = buildFfsFile({
    guid: DRIVER_GUID,
    typeCode: 0x07,
    payload: Buffer.from("payload"),
  });
  file.writeUIntLE(8192, 20, 3);
  const reader = await openReader(buildFv({ files: [file] }).buffer);
  const onOmission = vi.fn();
  const onCoverage = vi.fn();
  try {
    const entries = await collectEntries(reader, { onOmission, onCoverage });
    const retained = entries.find(({ kind }) => kind === "file");
    expect(retained).toMatchObject({ byteOffset: 72, declaredSize: 4024 });
    if (retained === undefined) throw new Error("readable FFS bytes were lost");
    const bytes = await readAll(await reader.open(retained));
    expect(bytes.length).toBe(4024);
    expect(onOmission).toHaveBeenCalledWith({
      path: retained.path,
      kind: "unsupported",
    });
    expect(onCoverage).toHaveBeenCalledWith({
      status: "unknown",
      limitations: [expect.stringMatching(/0x48.*8192.*4024/u)],
    });
  } finally {
    await reader.close();
  }
});

it("marks inventory coverage unknown for unexpected bytes between two retained files", async () => {
  const file = buildFfsFile({
    guid: DRIVER_GUID,
    typeCode: 1,
    payload: Buffer.from([1]),
  });
  const sibling = buildFfsFile({
    guid: "81111111-2222-3333-4444-555555555555",
    typeCode: 1,
    payload: Buffer.from([2]),
  });
  const image = buildFv({ files: [file, sibling] }).buffer;
  image[99] = 0x42;
  const reader = await openReader(image);
  const onOmission = vi.fn();
  const onCoverage = vi.fn();
  try {
    const entries = await collectEntries(reader, { onOmission, onCoverage });
    expect(
      entries
        .filter(({ kind }) => kind === "file")
        .map(({ byteOffset }) => byteOffset),
    ).toEqual([72, 104]);
    expect(onOmission).toHaveBeenCalledExactlyOnceWith({
      kind: "unsupported",
      path: "firmware-volume-0x0/ffs-padding-0x61",
    });
    expect(onCoverage).toHaveBeenCalledWith({
      status: "unknown",
      limitations: [expect.stringMatching(/0x61.*7 bytes/u)],
    });
  } finally {
    await reader.close();
  }
});

it("retains a file in the erased tail claimed by the FV extension and reports unknown inventory", async () => {
  const file = buildFfsFile({
    guid: DRIVER_GUID,
    typeCode: 1,
    payload: Buffer.from([0x31]),
  });
  const { buffer } = buildFv({ files: [file], extendedHeader: "standalone" });
  buffer.writeUInt32LE(104, 96);
  const reader = await openReader(buffer);
  const onOmission = vi.fn();
  const onCoverage = vi.fn();
  try {
    const entries = await collectEntries(reader, { onOmission, onCoverage });
    expect(
      entries
        .filter(({ kind }) => kind === "file")
        .map(({ byteOffset }) => byteOffset),
    ).toEqual([104]);
    expect(onOmission).toHaveBeenCalledExactlyOnceWith({
      kind: "unsupported",
      path: "firmware-volume-0x0/fv-extension-0x60",
    });
    expect(onCoverage).toHaveBeenCalledWith({
      status: "unknown",
      limitations: [
        expect.stringMatching(/UsedSize.*observed FFS file end at 0x81/u),
      ],
    });
  } finally {
    await reader.close();
  }
});

it("retains FFS siblings in inventory after skipping an unrepresentable invalid header", async () => {
  const invalid = Buffer.alloc(32, 0xff);
  invalid[19] = 1;
  invalid[23] = 0x1f;
  const sibling = buildFfsFile({
    guid: DRIVER_GUID,
    typeCode: 1,
    payload: Buffer.from([0x31]),
  });
  const reader = await openReader(
    buildFv({
      files: [invalid, sibling],
      fileSystemGuid: FFS3_FILE_SYSTEM_GUID,
    }).buffer,
  );
  const onOmission = vi.fn();
  const onCoverage = vi.fn();
  try {
    const entries = await collectEntries(reader, { onOmission, onCoverage });
    expect(
      entries
        .filter(({ kind }) => kind === "file")
        .map(({ byteOffset }) => byteOffset),
    ).toEqual([104]);
    expect(onOmission).toHaveBeenCalledExactlyOnceWith({
      kind: "unsupported",
      path: "firmware-volume-0x0/ffs-header-0x48",
    });
    expect(onCoverage).toHaveBeenCalledWith({
      status: "unknown",
      limitations: [expect.stringContaining("0xffffffffffffffff")],
    });
  } finally {
    await reader.close();
  }
});
