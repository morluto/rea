import { describe, expect, it } from "vitest";

import {
  MFT_DEFAULT_RECORD_BYTES,
  MFT_MAX_FILE_BYTES,
  createMftDecoder,
  parseMftIndex,
  selectMftMetadata,
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
  readonly usaOffset?: number;
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
    const usaOffset = options.usaOffset ?? 48;
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
  const firstAttributeOffset =
    Math.ceil((48 + Math.max(0, usaEntries) * 2) / 8) * 8;
  view.setUint16(20, firstAttributeOffset, true);
  view.setUint16(22, options.flags ?? 0x0001, true);
  view.setUint32(24, firstAttributeOffset + 8, true);
  view.setUint32(firstAttributeOffset, 0xffff_ffff, true);
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
    const view = new DataView(stream.buffer, offset, record.length);
    if (view.getUint16(4, true) >= 48)
      view.setUint32(44, offset / record.length, true);
    offset += record.length;
  }
  return stream;
};

describe("MFT header facts", () => {
  it("inventories a clean record's header and verified fixups", () => {
    const parsed = parseMftIndex(streamOf(recordOf({ sequenceNumber: 5 })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.metadata).toMatchObject({
      kind: "ntfs-mft",
      record_bytes: MFT_DEFAULT_RECORD_BYTES,
      record_count: 1,
      in_use_record_count: 1,
      directory_record_count: 0,
      extension_record_count: 0,
      fixup_mismatch_count: 0,
      fixup_unverified_record_count: 0,
      truncated_tail_bytes: 0,
      file_name_count: 0,
      file_name_incomplete_record_count: 0,
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

  it("identifies unrecognized flags without losing their source bits", () => {
    const parsed = parseMftIndex(recordOf({ flags: 0x8001 }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.metadata.record_headers[0]?.flags).toEqual({
      raw: 0x8001,
      names: ["in-use"],
      unknownMask: 0x8000,
    });
  });

  it.each([
    [0, 1],
    [49, 1],
    [64, 1],
    [72, 1],
    [48, 1],
    [48, 0],
  ])(
    "reports invalid first attribute offset %i with USA sequence %i",
    (offset, sequenceNumber) => {
      const record = recordOf({ sequenceNumber });
      new DataView(record.buffer).setUint16(20, offset, true);
      const parsed = parseMftIndex(record);
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(parsed.value.records[0]?.extentValid).toBe(false);
      expect(parsed.value.limitations.join(" ")).toContain("inconsistent");
    },
  );

  it.each([1, 0, 0xffff])(
    "reports a contradictory declared record number with USA sequence %i",
    (sequenceNumber) => {
      const bytes = streamOf(recordOf(), recordOf({ sequenceNumber }));
      new DataView(bytes.buffer).setUint32(1024 + 44, 0, true);
      const parsed = parseMftIndex(bytes);
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(parsed.value.records[1]).toMatchObject({
        index: 1,
        declaredRecordNumber: 0,
        recordNumberMatchesSlot: false,
        fixups: {
          malformed: sequenceNumber === 0 || sequenceNumber === 0xffff,
        },
      });
      expect(parsed.value.metadata.fixup_unverified_record_count).toBe(
        sequenceNumber === 1 ? 0 : 1,
      );
      expect(parsed.value.limitations.join(" ")).toContain(
        "disagrees with their stream slot",
      );
    },
  );

  it("keeps the inline header window separate from the parsed record count", () => {
    const parsed = parseMftIndex(
      streamOf(...Array.from({ length: 33 }, () => recordOf())),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.metadata).toMatchObject({
      record_count: 33,
      omitted_record_headers: 1,
      next_record_header_index: 32,
    });
    expect(parsed.value.metadata.record_headers).toHaveLength(32);
    expect(parsed.value.records).toHaveLength(33);
    const lastPage = parseMftIndex(
      streamOf(...Array.from({ length: 33 }, () => recordOf())),
      32,
    );
    if (!lastPage.ok) throw new Error(lastPage.error.message);
    expect(lastPage.value.metadata).toMatchObject({
      record_count: 33,
      record_header_start_index: 32,
      record_headers: [{ index: 32 }],
      next_record_header_index: null,
    });
    expect(parsed.value.limitations).toEqual([]);
  });

  it("preserves a log sequence number above the safe integer range", () => {
    const record = recordOf();
    new DataView(record.buffer).setBigUint64(8, 9007199254740993n, true);
    const parsed = parseMftIndex(record);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.records[0]?.logFileSequenceNumber).toBe(
      "9007199254740993",
    );
  });

  it("verifies the older FILE header without reading its fixup words as a record number", () => {
    const oldRecord = recordOf({ usaOffset: 42 });
    const newRecord = recordOf();
    new DataView(newRecord.buffer).setUint32(44, 1, true);

    const parsed = parseMftIndex(streamOf(oldRecord, newRecord));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.records).toMatchObject([
      {
        declaredRecordNumber: null,
        fixups: { malformed: false, verifiedSectors: 2 },
      },
      {
        declaredRecordNumber: 1,
        fixups: { malformed: false, verifiedSectors: 2 },
      },
    ]);
    expect(parsed.value.limitations).toEqual([]);
  });
});

describe("MFT fixup coverage", () => {
  it.each([0, 0xffff])(
    "leaves reserved USA sequence %i unverified",
    (sequenceNumber) => {
      const parsed = parseMftIndex(recordOf({ sequenceNumber }));
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(parsed.value.records[0]?.fixups).toMatchObject({
        sequenceNumber,
        verifiedSectors: 0,
        malformed: true,
      });
      expect(parsed.value.metadata.fixup_unverified_record_count).toBe(1);
      expect(parsed.value.limitations.join(" ")).toContain(
        "invalid or incomplete",
      );
    },
  );
});

describe("MFT resident names", () => {
  it("decodes a FILE_NAME across a restored sector trailer without changing the source bytes", () => {
    const bytes = recordOf();
    const view = new DataView(bytes.buffer);
    const attribute = 416;
    const value = attribute + 24;
    view.setUint16(20, attribute, true);
    view.setUint32(24, 528, true);
    view.setUint32(attribute, 0x30, true);
    view.setUint32(attribute + 4, 104, true);
    view.setUint32(attribute + 16, 76, true);
    view.setUint16(attribute + 20, 24, true);
    view.setBigUint64(value, 0x1234_0000_0000_0005n, true);
    bytes.set([5, 1], value + 64);
    bytes.set(Buffer.from("names", "utf16le"), value + 66);
    view.setUint16(50, view.getUint16(510, true), true);
    view.setUint16(510, view.getUint16(48, true), true);
    view.setUint32(520, 0xffff_ffff, true);
    const original = bytes.slice();

    const parsed = parseMftIndex(bytes);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.metadata.record_headers[0]).toMatchObject({
      fileNameCoverage: "complete",
      fileNames: [
        {
          fileOffset: value,
          parent: { recordNumber: 5, sequenceNumber: 0x1234 },
          namespace: 1,
          name: "names",
        },
      ],
    });
    expect(bytes).toEqual(original);
  });

  it("preserves multiple hard-link names with independent parents and source metadata", () => {
    const bytes = recordOf({ hardLinkCount: 2 });
    const view = new DataView(bytes.buffer);
    for (const [index, name] of ["first", "second"].entries()) {
      const attribute = 56 + index * 104;
      const value = attribute + 24;
      view.setUint32(attribute, 0x30, true);
      view.setUint32(attribute + 4, 104, true);
      view.setUint32(attribute + 16, 66 + name.length * 2, true);
      view.setUint16(attribute + 20, 24, true);
      view.setBigUint64(value, (3n << 48n) | BigInt(5 + index), true);
      view.setBigUint64(value + 8, 133000000000000001n, true);
      view.setBigUint64(value + 48, 9007199254740993n, true);
      bytes.set([name.length, index + 1], value + 64);
      bytes.set(Buffer.from(name, "utf16le"), value + 66);
    }
    view.setUint32(264, 0xffffffff, true);
    view.setUint32(24, 272, true);
    const parsed = parseMftIndex(bytes);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.metadata.record_headers[0]).toMatchObject({
      fileNameCoverage: "complete",
      fileNames: [
        {
          name: "first",
          parent: { recordNumber: 5 },
          fileOffset: 80,
          createdFileTime: "133000000000000001",
          dataBytes: "9007199254740993",
        },
        {
          name: "second",
          parent: { recordNumber: 6 },
          fileOffset: 184,
          namespace: 2,
        },
      ],
    });
    expect(parsed.value.metadata.file_name_count).toBe(2);
  });
});

describe("MFT fixup failures", () => {
  it("keeps a record whose sector trailer is not the sequence number, and reports it", () => {
    const parsed = parseMftIndex(
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
    const parsed = parseMftIndex(streamOf(recordOf({ usaEntries: 0 })));
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
      /invalid or incomplete update sequence array/u,
    );
  });

  it.each([
    [48, 4],
    [49, 3],
    [508, 3],
  ])(
    "rejects a malformed update sequence array at %i with %i entries",
    (offset, count) => {
      const bytes = recordOf();
      const view = new DataView(bytes.buffer);
      view.setUint16(4, offset, true);
      view.setUint16(6, count, true);

      const parsed = parseMftIndex(bytes);
      if (!parsed.ok) throw new Error(parsed.error.message);
      expect(parsed.value.records[0]?.fixups).toMatchObject({
        malformed: true,
        verifiedSectors: 0,
      });
      expect(parsed.value.metadata.fixup_unverified_record_count).toBe(1);
    },
  );

  it("counts uncovered sectors independently of a mismatched trailer", () => {
    const parsed = parseMftIndex(
      recordOf({ recordBytes: 4096, usaEntries: 3, corruptSector: 0 }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.metadata).toMatchObject({
      fixup_mismatch_count: 1,
      fixup_unverified_record_count: 1,
    });
    expect(parsed.value.limitations.join(" ")).toContain(
      "invalid or incomplete",
    );
  });

  it("reports an array that covers fewer sectors than the record has", () => {
    // A 4 KiB record holds eight sectors; a three-entry array leaves five unverified.
    const parsed = parseMftIndex(
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
});

describe("MFT record slots", () => {
  it("distinguishes extension records from base records", () => {
    const parsed = parseMftIndex(
      streamOf(
        recordOf(),
        recordOf({
          flags: 0x0005,
          baseRecordReference: 0xabcd_fedc_ba98_7654n,
        }),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.records[1]).toMatchObject({
      baseRecordReference: {
        recordNumber: 0xfedc_ba98_7654,
        sequenceNumber: 0xabcd,
      },
      flags: { raw: 0x0005, names: ["in-use", "system"] },
    });
    expect(parsed.value.metadata.extension_record_count).toBe(1);
  });

  it("names directory records without losing the in-use flag", () => {
    const parsed = parseMftIndex(streamOf(recordOf({ flags: 0x0003 })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.records[0]).toMatchObject({
      directory: true,
      inUse: true,
      flags: { names: ["in-use", "directory"] },
    });
    expect(parsed.value.metadata.directory_record_count).toBe(1);
  });

  it("skips malformed and sparse slots without renumbering valid records", () => {
    const stream = streamOf(
      recordOf(),
      recordOf(),
      new Uint8Array(MFT_DEFAULT_RECORD_BYTES),
      recordOf(),
    );
    stream.set(Buffer.from("BAAD", "latin1"), MFT_DEFAULT_RECORD_BYTES);
    const parsed = parseMftIndex(stream);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.metadata.record_count).toBe(2);
    expect(
      parsed.value.records.map(({ index, fileOffset }) => [index, fileOffset]),
    ).toEqual([
      [0, 0],
      [3, 3 * MFT_DEFAULT_RECORD_BYTES],
    ]);
    expect(parsed.value.limitations).toEqual([
      "record at 1024 does not begin with the FILE signature; 2 slot(s) without a FILE signature were found",
    ]);
  });

  it("keeps a trailing partial record out of the inventory", () => {
    const stream = new Uint8Array(1024 + 300);
    stream.set(recordOf(), 0);
    const parsed = parseMftIndex(stream);
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
    const parsed = parseMftIndex(record);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.recordBytes).toBe(MFT_DEFAULT_RECORD_BYTES);
    expect(parsed.value.limitations.join(" ")).toMatch(
      /not a supported power of two/u,
    );
  });

  it("reads a 4 KiB record at its declared size", () => {
    const parsed = parseMftIndex(streamOf(recordOf({ recordBytes: 4096 })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.recordBytes).toBe(4096);
    expect(parsed.value.metadata.record_count).toBe(1);
  });
});

describe("parseMftIndex refusals and limits", () => {
  it("refuses a file shorter than one record header", () => {
    const parsed = parseMftIndex(new Uint8Array(32));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toMatch(
      /shorter than one 42-byte record header/u,
    );
  });

  it("refuses bytes that do not start with the FILE signature", () => {
    const parsed = parseMftIndex(Buffer.alloc(2048, 0x41));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toMatch(
      /does not begin with the FILE signature/u,
    );
  });

  it("refuses a file above the fixed ceiling", () => {
    const decoder = createMftDecoder(MFT_MAX_FILE_BYTES + 1);
    expect(decoder.ok).toBe(false);
    if (decoder.ok) return;
    expect(decoder.error).toMatchObject({
      kind: "limit",
      boundary: "file-size",
    });
  });

  it("refuses streams that differ from the admitted byte count", () => {
    const stream = recordOf();
    const short = createMftDecoder(stream.length + 1);
    if (!short.ok) throw new Error(short.error.message);
    expect(short.value.write(stream).ok).toBe(true);
    expect(short.value.finish()).toMatchObject({
      ok: false,
      error: {
        kind: "format",
        message: "stream ended before the admitted file length",
      },
    });

    const long = createMftDecoder(stream.length - 1);
    if (!long.ok) throw new Error(long.error.message);
    expect(long.value.write(stream)).toMatchObject({
      ok: false,
      error: {
        kind: "format",
        message: "received more bytes than the admitted file length",
      },
    });
  });

  it("returns the same inventory without retaining all the decoded records", () => {
    const bytes = streamOf(...Array.from({ length: 33 }, () => recordOf()));
    const decoder = createMftDecoder(bytes.length);
    const parsed = parseMftIndex(bytes);
    if (!decoder.ok || !parsed.ok) throw new Error("invalid fixture");
    expect(decoder.value.write(bytes).ok).toBe(true);
    const inventory = decoder.value.finish();
    if (!inventory.ok) throw new Error(inventory.error.message);
    expect(inventory.value).not.toHaveProperty("records");
    expect(inventory.value.metadata).toEqual(parsed.value.metadata);
    expect(inventory.value.limitations).toEqual(parsed.value.limitations);
    expect(parsed.value.records).toHaveLength(33);
    expect(parsed.value.records[32]).not.toHaveProperty("attributes");
    expect(parsed.value.records[32]).not.toHaveProperty("fileNames");
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

it("selects bounded details by source slot from the existing index, including sparse slots", () => {
  const bytes = streamOf(
    ...Array.from({ length: 40 }, (_, slot) =>
      slot === 33 ? new Uint8Array(1024) : recordOf(),
    ),
  );
  const original = bytes.slice();
  const indexed = parseMftIndex(bytes, 0, 0);
  if (!indexed.ok) throw new Error(indexed.error.message);
  expect(indexed.value.records).toHaveLength(39);
  expect(selectMftMetadata(bytes, indexed.value, 0, 0)).toMatchObject({
    record_count: 39,
    record_headers: [],
    omitted_record_headers: 39,
    next_record_header_index: 0,
  });
  const page = selectMftMetadata(bytes, indexed.value, 32, 2);
  expect(
    page.record_headers.map(({ index, fileOffset }) => [index, fileOffset]),
  ).toEqual([
    [32, 32768],
    [34, 34816],
  ]);
  expect(page).toMatchObject({
    omitted_record_headers: 37,
    record_header_start_index: 32,
    next_record_header_index: 35,
  });
  expect(
    selectMftMetadata(bytes, indexed.value, 33, 1).record_headers[0]?.index,
  ).toBe(34);
  expect(selectMftMetadata(bytes, indexed.value, 39, 32)).toMatchObject({
    record_headers: [{ index: 39 }],
    next_record_header_index: null,
  });
  expect(selectMftMetadata(bytes, indexed.value, 40, 1)).toMatchObject({
    record_headers: [],
    next_record_header_index: null,
  });
  expect(bytes).toEqual(original);
  expect(indexed.value.metadata.record_headers).toEqual([]);
});
