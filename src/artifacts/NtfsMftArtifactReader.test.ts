import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactFileSource } from "./ArtifactFileSource.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { NtfsMftArtifactReader } from "./NtfsMftArtifactReader.js";

import { MFT_DEFAULT_RECORD_BYTES } from "../domain/windows/ntfsMft.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

/** A 1 KiB FILE record whose update sequence array covers both sectors. */
const recordBytes = (options: {
  readonly sequenceNumber?: number;
  readonly flags?: number;
  readonly index?: number;
}): Buffer => {
  const record = Buffer.alloc(MFT_DEFAULT_RECORD_BYTES);
  record.write("FILE", 0, "latin1");
  const sequenceNumber = options.sequenceNumber ?? 1;
  record.writeUInt16LE(48, 4);
  record.writeUInt16LE(3, 6);
  record.writeUInt16LE(sequenceNumber, 48);
  record.writeUInt16LE(0xa5a5, 50);
  record.writeUInt16LE(0xa5a5, 52);
  record.writeUInt16LE(sequenceNumber, 16);
  record.writeUInt16LE(1, 18);
  record.writeUInt32LE(options.index ?? 0, 44);
  record.writeUInt16LE(56, 20);
  record.writeUInt16LE(options.flags ?? 0x0001, 22);
  record.writeUInt32LE(64, 24);
  record.writeUInt32LE(0xffff_ffff, 56);
  record.writeUInt32LE(MFT_DEFAULT_RECORD_BYTES, 28);
  record.writeUInt16LE(sequenceNumber, 510);
  record.writeUInt16LE(sequenceNumber, 1022);
  return record;
};

const writeMft = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-ntfs-mft-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

it("reports a $MFT stream's record headers as the root occurrence", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeMft(
      "$MFT",
      Buffer.concat([
        recordBytes({}),
        recordBytes({ flags: 0x0003, index: 1 }),
      ]),
    ),
  );
  expect(inventory.manifest.root_format).toBe("ntfs-mft");
  expect(inventory.coverage.status).toBe("complete");
  // A record stream declares no members, so the root is its whole inventory.
  expect(inventory.occurrences.map((row) => row.logical_path)).toEqual(["."]);
  expect(inventory.occurrences[0]).toMatchObject({
    artifact_format: "ntfs-mft",
    format_metadata: {
      kind: "ntfs-mft",
      record_bytes: MFT_DEFAULT_RECORD_BYTES,
      record_count: 2,
      in_use_record_count: 2,
      directory_record_count: 1,
      extension_record_count: 0,
      fixup_mismatch_count: 0,
      fixup_unverified_record_count: 0,
      truncated_tail_bytes: 0,
    },
  });
});

it("names a failed fixup in the coverage limitations", async () => {
  const record = recordBytes({ sequenceNumber: 4 });
  // A trailer that is not the sequence number marks the sector as not cleanly written.
  record.writeUInt16LE(0x1234, 510);
  const inventory = await scanCanonicalArtifactInventory(
    await writeMft("$MFT", record),
  );
  expect(inventory.manifest.root_format).toBe("ntfs-mft");
  expect(inventory.coverage.status).toBe("unknown");
  expect(inventory.limitations).toContainEqual(
    expect.stringMatching(/sector trailer that is not the update sequence/u),
  );
});

it("reports an unaligned used-byte count as incomplete coverage", async () => {
  const record = recordBytes({});
  record.writeUInt32LE(57, 24);
  const inventory = await scanCanonicalArtifactInventory(
    await writeMft("$MFT", record),
  );
  expect(inventory.coverage.status).toBe("unknown");
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    record_headers: [{ usedBytes: 57, extentValid: false }],
  });
});

it("reports incomplete coverage when FILE extents contradict the record slots", async () => {
  const usedTooLarge = recordBytes({});
  usedTooLarge.writeUInt32LE(4096, 24);
  const totalTooSmall = recordBytes({});
  totalTooSmall.writeUInt32LE(512, 28);

  const inventory = await scanCanonicalArtifactInventory(
    await writeMft("$MFT", Buffer.concat([usedTooLarge, totalTooSmall])),
  );
  expect(inventory.coverage.status).toBe("unknown");
  expect(inventory.limitations).toContainEqual(
    "2 FILE record(s) declare inconsistent record extents, beginning at offset 0",
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    record_count: 2,
    fixup_mismatch_count: 0,
    fixup_unverified_record_count: 0,
  });
});

it("retries after final source verification fails without publishing its metadata", async () => {
  const reader = new NtfsMftArtifactReader(
    await writeMft("$MFT", recordBytes({})),
  );
  const read = ArtifactFileSource.prototype.read;
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementationOnce(function (this: ArtifactFileSource, signal) {
      return read.call(this, signal);
    })
    .mockRejectedValueOnce(new Error("final source verification failed"));
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toThrow("final source verification failed");
    expect(reader.formatMetadata()).toBeUndefined();
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).resolves.toMatchObject({
      done: true,
    });
    expect(reader.formatMetadata()).toMatchObject({
      kind: "ntfs-mft",
      record_count: 1,
    });
  } finally {
    spy.mockRestore();
    await reader.close();
  }
});

it("retries a shared preparation cancelled by another traversal", async () => {
  const reader = new NtfsMftArtifactReader(
    await writeMft("$MFT", recordBytes({})),
  );
  const controller = new AbortController();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const read = ArtifactFileSource.prototype.read;
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementationOnce(async function (this: ArtifactFileSource, signal) {
      entered();
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      assertArtifactReadActive(signal);
      return read.call(this, signal);
    });
  try {
    const cancelled = reader
      .entries(controller.signal)
      [Symbol.asyncIterator]()
      .next();
    const cancelledResult = expect(cancelled).rejects.toMatchObject({
      reason: "cancelled",
    });
    await started;
    const other = reader.entries()[Symbol.asyncIterator]().next();
    controller.abort("cancelled first traversal");
    await cancelledResult;
    await expect(other).resolves.toMatchObject({ done: true });
    expect(reader.formatMetadata()).toMatchObject({ record_count: 1 });
  } finally {
    controller.abort();
    spy.mockRestore();
    await reader.close();
  }
});

it("revalidates the source before reusing a completed header inventory", async () => {
  const path = await writeMft("$MFT", recordBytes({}));
  const reader = new NtfsMftArtifactReader(path);
  try {
    await reader.entries()[Symbol.asyncIterator]().next();
    await writeFile(
      path,
      Buffer.concat([recordBytes({}), recordBytes({ index: 1 })]),
    );
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "integrity" });
  } finally {
    await reader.close();
  }
});
