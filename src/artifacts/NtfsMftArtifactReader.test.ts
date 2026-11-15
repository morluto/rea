import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactFileSource } from "./ArtifactFileSource.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { NtfsMftArtifactReader } from "./NtfsMftArtifactReader.js";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";

// The constructed FILE records intentionally use the 1024-byte default.
const MFT_DEFAULT_RECORD_BYTES = 1024;
import { linkedMftFixture } from "../../tests/fixtures/ntfsMftExtension.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

/** A 1 KiB FILE record whose update sequence array covers both sectors. */
const recordBytes = (options: {
  readonly sequenceNumber?: number;
  readonly flags?: number;
  readonly index?: number;
  readonly name?: string;
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
  const attribute = 56;
  let end = attribute;
  if (options.name !== undefined) {
    const valueBytes = 66 + Buffer.byteLength(options.name, "utf16le");
    const length = Math.ceil((24 + valueBytes) / 8) * 8;
    record.writeUInt32LE(0x30, attribute);
    record.writeUInt32LE(length, attribute + 4);
    record.writeUInt32LE(valueBytes, attribute + 16);
    record.writeUInt16LE(24, attribute + 20);
    const value = attribute + 24;
    record.writeUInt8(options.name.length, value + 64);
    record.write(options.name, value + 66, "utf16le");
    end += length;
  }
  record.writeUInt32LE(end + 8, 24);
  record.writeUInt32LE(0xffff_ffff, end);
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
        recordBytes({ name: "sample" }),
        recordBytes({ flags: 0x0003, index: 1 }),
      ]),
    ),
  );
  expect(inventory.manifest.root_format).toBe("ntfs-mft");
  expect(inventory.coverage.status).toBe("complete");
  const limitations = inventory.limitations.join(" ");
  expect(limitations).not.toMatch(
    /attributes, filenames.*not decoded|no path, file size/iu,
  );
  expect(limitations).toContain(
    "Nonresident list values and file contents are not recovered",
  );
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
      record_headers: [
        {
          fileNames: [{ name: "sample" }],
          attributes: [{ type: 0x30, storage: { kind: "resident" } }],
        },
        {},
      ],
      file_name_count: 1,
      file_name_incomplete_record_count: 0,
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
    await awaitAcknowledgement(started, cancelled, "NTFS traversal read");
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

it("reports cancellation during MFT coverage", async () => {
  const path = await writeMft("$MFT", recordBytes({}));
  const reader = new NtfsMftArtifactReader(path);
  const controller = new AbortController();
  try {
    const entries = reader
      .entries(controller.signal, {
        onCoverage: () => controller.abort(),
      })
      [Symbol.asyncIterator]();
    await expect(entries.next()).rejects.toMatchObject({ reason: "cancelled" });
  } finally {
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

it("delivers acquired extension metadata through the canonical inventory schema", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeMft("linked", linkedMftFixture()),
  );
  expect(inventory.occurrences[0]).toMatchObject({
    artifact_format: "ntfs-mft",
    format_metadata: {
      record_count: 2,
      extension_record_count: 1,
      file_name_count: 2,
      record_headers: [
        {
          index: 0,
          fileNames: [{ name: "local" }],
          attributeListResolution: {
            coverage: "complete",
            references: [
              { result: { kind: "resolved", attributeFileOffset: 1080 } },
            ],
            linkedFileNames: [{ name: "linked", fileOffset: 1104 }],
          },
        },
        {
          index: 1,
          baseRecordReference: { recordNumber: 0, sequenceNumber: 2 },
          fileNames: [{ name: "linked" }],
        },
      ],
    },
  });
});

it("does not finish a traversal when close begins during final source verification", async () => {
  const reader = new NtfsMftArtifactReader(
    await writeMft("$MFT", recordBytes({})),
  );
  const read = ArtifactFileSource.prototype.read;
  let calls = 0;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementation(async function (this: ArtifactFileSource, signal) {
      const result = await read.call(this, signal);
      if (++calls === 2) {
        entered();
        await gate;
      }
      return result;
    });
  try {
    const traversal = reader.entries()[Symbol.asyncIterator]().next();
    const rejected = expect(traversal).rejects.toMatchObject({
      reason: "unavailable",
    });
    await awaitAcknowledgement(started, traversal, "NTFS close read");
    const closing = reader.close();
    resume();
    await rejected;
    await closing;
    expect(calls).toBe(2);
  } finally {
    resume();
    spy.mockRestore();
    await reader.close();
  }
});
