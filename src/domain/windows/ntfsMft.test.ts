import { describe, expect, it } from "vitest";

import {
  DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
  MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
  MFT_DEFAULT_RECORD_BYTES,
  MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
  NTFS_MFT_FILE_LIMIT_CODE,
  NTFS_MFT_MAX_FILE_SETTING_ID,
  createMftDecoder,
  ntfsMftFileLimit,
  parseMftImage,
} from "./ntfsMft.js";

interface RecordOptions {
  readonly sequenceNumber?: number;
  readonly hardLinkCount?: number;
  readonly flags?: number;
  readonly baseRecordReference?: bigint;
  readonly recordBytes?: number;
  /** Write a wrong trailer value into this sector, leaving the others correct. */
  readonly corruptSector?: number;
  /** Truncate the update sequence array to this many entries; 0 omits it. */
  readonly usaEntries?: number;
}

/** One FILE record with a zeroed body and fixups applied the way NTFS writes them. */
const recordOf = (options: RecordOptions = {}): Uint8Array => {
  const recordBytes = options.recordBytes ?? MFT_DEFAULT_RECORD_BYTES;
  const record = new Uint8Array(recordBytes);
  const view = new DataView(record.buffer);
  record.set(Buffer.from("FILE", "latin1"), 0);
  const sequenceNumber = options.sequenceNumber ?? 1;
  const sectors = recordBytes / 512;

  const usaEntries = options.usaEntries ?? sectors + 1;
  if (usaEntries > 0) {
    const usaOffset = 48;
    view.setUint16(4, usaOffset, true);
    view.setUint16(6, usaEntries, true);
    view.setUint16(usaOffset, sequenceNumber, true);
    for (let sector = 0; sector < sectors; sector += 1) {
      const trailer = sector * 512 + 510;
      // A saved trailer is what the sector held before the fixup replaced it.
      view.setUint16(usaOffset + 2 * (sector + 1), 0xa5a5, true);
      view.setUint16(
        trailer,
        sector >= usaEntries - 1
          ? 0xa5a5
          : sector === options.corruptSector
            ? 0x1234
            : sequenceNumber,
        true,
      );
    }
  } else {
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
  }

  view.setUint16(16, sequenceNumber, true);
  view.setUint16(18, options.hardLinkCount ?? 1, true);
  view.setUint16(20, 56, true);
  view.setUint16(22, options.flags ?? 0x0001, true);
  view.setUint32(24, 56, true);
  view.setUint32(28, recordBytes, true);
  view.setBigUint64(32, options.baseRecordReference ?? 0n, true);
  view.setUint16(40, 0, true);
  return record;
};

const streamOf = (...records: readonly Uint8Array[]): Uint8Array => {
  const total = records.reduce((sum, record) => sum + record.length, 0);
  const stream = new Uint8Array(total);
  let offset = 0;
  for (const record of records) {
    stream.set(record, offset);
    offset += record.length;
  }
  return stream;
};

describe("parseMftImage", () => {
  it("inventories a clean record's header and verified fixups", () => {
    const parsed = parseMftImage(streamOf(recordOf({ sequenceNumber: 5 })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.metadata).toEqual({
      kind: "ntfs-mft",
      record_bytes: MFT_DEFAULT_RECORD_BYTES,
      record_count: 1,
      in_use_record_count: 1,
      directory_record_count: 0,
      extension_record_count: 0,
      fixup_mismatch_count: 0,
      fixup_unverified_record_count: 0,
      truncated_tail_bytes: 0,
    });
    expect(parsed.value.records[0]).toMatchObject({
      index: 0,
      fileOffset: 0,
      sequenceNumber: 5,
      inUse: true,
      directory: false,
      baseRecordReference: null,
      firstAttributeOffset: 56,
      fixups: {
        sequenceNumber: 5,
        verifiedSectors: 2,
        coveredSectors: 2,
        mismatchSector: null,
        malformed: false,
      },
    });
    expect(parsed.value.limitations).toEqual([]);
  });

  it("keeps a record whose sector trailer is not the sequence number, and reports it", () => {
    const parsed = parseMftImage(
      streamOf(recordOf(), recordOf({ sequenceNumber: 9, corruptSector: 1 })),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.records[1]?.fixups).toMatchObject({
      sequenceNumber: 9,
      verifiedSectors: 1,
      mismatchSector: 1,
    });
    expect(parsed.value.metadata.fixup_mismatch_count).toBe(1);
    expect(parsed.value.limitations.join(" ")).toMatch(
      /1 record\(s\) hold a sector trailer/u,
    );
  });

  it("treats a missing update sequence array as unverified rather than clean", () => {
    const parsed = parseMftImage(streamOf(recordOf({ usaEntries: 0 })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.records[0]?.fixups).toMatchObject({
      malformed: true,
      mismatchSector: null,
      coveredSectors: 0,
    });
    expect(parsed.value.metadata.fixup_mismatch_count).toBe(0);
    expect(parsed.value.metadata.fixup_unverified_record_count).toBe(1);
    expect(parsed.value.limitations.join(" ")).toMatch(
      /update sequence array that does not cover every sector/u,
    );
  });

  it("reports an array that covers fewer sectors than the record has", () => {
    // A 4 KiB record holds eight sectors; a three-entry array leaves five unverified.
    const parsed = parseMftImage(
      streamOf(recordOf({ recordBytes: 4096, usaEntries: 3 })),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.records[0]?.fixups).toMatchObject({
      coveredSectors: 2,
      verifiedSectors: 2,
      mismatchSector: null,
      malformed: false,
    });
    expect(parsed.value.metadata.fixup_unverified_record_count).toBe(1);
  });

  it("distinguishes extension records from base records", () => {
    const parsed = parseMftImage(
      streamOf(
        recordOf(),
        recordOf({ flags: 0x0005, baseRecordReference: 0x0000000000000001n }),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.records[1]).toMatchObject({
      baseRecordReference: 1,
      flags: { raw: 0x0005, names: ["in-use", "extension"] },
    });
    expect(parsed.value.metadata.extension_record_count).toBe(1);
  });

  it("names directory records without losing the in-use flag", () => {
    const parsed = parseMftImage(streamOf(recordOf({ flags: 0x0003 })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.records[0]).toMatchObject({
      directory: true,
      inUse: true,
      flags: { names: ["in-use", "directory"] },
    });
    expect(parsed.value.metadata.directory_record_count).toBe(1);
  });

  it("stops at a record that does not begin with the FILE signature", () => {
    const stream = streamOf(recordOf(), recordOf(), recordOf());
    stream.set(Buffer.from("BAAD", "latin1"), 1024);
    const parsed = parseMftImage(stream);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.metadata.record_count).toBe(1);
    expect(parsed.value.limitations.join(" ")).toMatch(
      /record at 1024 does not begin with the FILE signature/u,
    );
  });

  it("keeps a trailing partial record out of the inventory", () => {
    const stream = new Uint8Array(1024 + 300);
    stream.set(recordOf(), 0);
    const parsed = parseMftImage(stream);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.metadata.record_count).toBe(1);
    expect(parsed.value.metadata.truncated_tail_bytes).toBe(300);
    expect(parsed.value.limitations.join(" ")).toMatch(
      /300 trailing byte\(s\)/u,
    );
  });

  it("falls back to the default record size when record 0 declares none", () => {
    const record = recordOf();
    new DataView(record.buffer).setUint32(28, 0, true);
    const parsed = parseMftImage(record);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.recordBytes).toBe(MFT_DEFAULT_RECORD_BYTES);
    expect(parsed.value.limitations.join(" ")).toMatch(
      /not a supported power of two/u,
    );
  });

  it("reads a 4 KiB record at its declared size", () => {
    const parsed = parseMftImage(streamOf(recordOf({ recordBytes: 4096 })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.recordBytes).toBe(4096);
    expect(parsed.value.metadata.record_count).toBe(1);
  });
});

describe("parseMftImage refusals and limits", () => {
  it("refuses a file shorter than one record header", () => {
    const parsed = parseMftImage(new Uint8Array(32));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toMatch(
      /shorter than one 48-byte record header/u,
    );
  });

  it("refuses bytes that do not start with the FILE signature", () => {
    const parsed = parseMftImage(Buffer.alloc(2048, 0x41));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toMatch(
      /does not begin with the FILE signature/u,
    );
  });

  it("refuses a file above the effective ceiling and names the setting", () => {
    const fileBytes = DEFAULT_NTFS_MFT_MAX_FILE_BYTES + 1;
    const fileLimit = ntfsMftFileLimit(fileBytes, {
      maximumBytes: DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
      source: "default",
    });
    const decoder = createMftDecoder(fileBytes);
    expect(decoder.ok).toBe(false);
    if (decoder.ok) return;
    expect(decoder.error).toMatchObject({
      kind: "limit",
      boundary: "file-size",
      fileAdmission: fileLimit,
    });
    expect(fileLimit).toEqual({
      code: NTFS_MFT_FILE_LIMIT_CODE,
      setting: NTFS_MFT_MAX_FILE_SETTING_ID,
      fileBytes,
      maximumBytes: DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
      source: "default",
      defaultBytes: DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
      floorBytes: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
      maximumSettingBytes: MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
      updateMode: "runtime",
      pendingRestart: false,
    });
  });

  it("uses a caller-selected ceiling instead of the default", () => {
    const admission = {
      maximumBytes: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
      source: "setting" as const,
    };
    const refused = createMftDecoder(
      MINIMUM_NTFS_MFT_MAX_FILE_BYTES + 1,
      admission,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.fileAdmission).toMatchObject({
      code: NTFS_MFT_FILE_LIMIT_CODE,
      setting: NTFS_MFT_MAX_FILE_SETTING_ID,
      maximumBytes: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
      source: "setting",
      updateMode: "runtime",
      pendingRestart: false,
    });
    expect(
      createMftDecoder(MINIMUM_NTFS_MFT_MAX_FILE_BYTES, admission).ok,
    ).toBe(true);
  });

  it("decodes the same stream through the chunked decoder", () => {
    const stream = streamOf(recordOf(), recordOf({ flags: 0x0003 }));
    const decoder = createMftDecoder(stream.length);
    expect(decoder.ok).toBe(true);
    if (!decoder.ok) return;
    // Feed one byte past a record boundary so a chunk never aligns with a record.
    for (const chunk of [stream.subarray(0, 1025), stream.subarray(1025)])
      expect(decoder.value.write(chunk).ok).toBe(true);
    const image = decoder.value.finish();
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    expect(image.value.metadata.record_count).toBe(2);
    expect(image.value.metadata.directory_record_count).toBe(1);
  });
});
