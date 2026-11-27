import { describe, expect, it } from "vitest";
import { DEFAULT_ANDROID_DTBO_READER_LIMITS } from "../artifactReaderLimits.js";
import {
  ANDROID_DTBO_FORMAT,
  ANDROID_DTBO_LIMITS,
  ANDROID_DTBO_MAGIC,
  decodeDtboCompression,
  hasAndroidDtboMagic,
  parseAndroidDtboEntries,
  parseAndroidDtboHeader,
} from "./androidDtboFormat.js";
import {
  buildSyntheticAndroidDtbo,
  sampleAndroidDtboV0,
  sampleAndroidDtboV1Mixed,
} from "../../../tests/fixtures/androidDtbo.js";

describe("androidDtboFormat", () => {
  it("recognizes big-endian 0xd7b7ab1e magic and rejects non-DTBO headers", () => {
    expect(hasAndroidDtboMagic(Buffer.from([0xd7, 0xb7, 0xab, 0x1e]))).toBe(
      true,
    );
    expect(hasAndroidDtboMagic(Buffer.from([0xd0, 0x0d, 0xfe, 0xed]))).toBe(
      false,
    );
    expect(hasAndroidDtboMagic(Buffer.from([0xd7, 0xb7, 0xab]))).toBe(false);
  });

  it("decodes v1 compression modes from the low nibble while ignoring upper flag bits", () => {
    expect(decodeDtboCompression(0x00)).toBe("none");
    expect(decodeDtboCompression(0x01)).toBe("zlib");
    expect(decodeDtboCompression(0x02)).toBe("gzip");
    expect(decodeDtboCompression(0x03)).toBe("unknown");
    expect(decodeDtboCompression(0x8000_0002)).toBe("gzip");
  });

  it("parses a valid v0 DTBO header and entry table with custom[4] words", () => {
    const { image, entries } = sampleAndroidDtboV0();
    const headerResult = parseAndroidDtboHeader(image, image.length);
    if (!headerResult.ok) throw headerResult.error;

    expect(headerResult.value).toMatchObject({
      magic: ANDROID_DTBO_MAGIC,
      totalSize: image.length,
      headerSize: 32,
      dtEntrySize: 32,
      dtEntryCount: 2,
      dtEntriesOffset: 32,
      pageSize: 2048,
      version: 0,
      tableSize: 64,
      limitations: [],
    });

    const tableSlice = image.subarray(
      headerResult.value.dtEntriesOffset,
      headerResult.value.dtEntriesOffset + headerResult.value.tableSize,
    );
    const tableResult = parseAndroidDtboEntries(headerResult.value, tableSlice);
    if (!tableResult.ok) throw tableResult.error;

    expect(tableResult.value.limitations).toEqual([]);
    expect(tableResult.value.entries).toHaveLength(2);
    expect(tableResult.value.entries[0]).toMatchObject({
      index: 0,
      dtSize: entries[0]!.length,
      dtOffset: 96,
      id: 0x00000101,
      rev: 0x00010000,
      flags: null,
      compression: null,
      custom: [0x11111111, 0x22222222, 0x33333333, 0x44444444],
    });
    expect(tableResult.value.entries[1]).toMatchObject({
      index: 1,
      dtSize: entries[1]!.length,
      dtOffset: 96 + entries[0]!.length,
      id: 0x00000202,
      rev: 0x00020001,
      flags: null,
      compression: null,
      custom: [0xaaaaaaaa, 0xbbbbbbbb, 0xcccccccc, 0xdddddddd],
    });
  });

  it("parses a v1 page-aligned image with compression flags, custom[3], extra header/entry bytes, and trailing bytes", () => {
    const base = sampleAndroidDtboV1Mixed();
    const padded = buildSyntheticAndroidDtbo({
      version: 1,
      pageSize: 4096,
      headerSize: 48,
      dtEntrySize: 40,
      pageAlignPayloads: true,
      trailingBytes: Buffer.from("TRAILING_AVB_OR_PAD"),
      entries: [
        {
          payload: base.plainOverlay,
          id: 0x10,
          rev: 1,
          flags: 0x8000_0000,
          custom: [1, 2, 3],
        },
        {
          payload: base.gzipPayload,
          id: 0x20,
          rev: 2,
          flags: 0x02,
          custom: [4, 5, 6],
        },
      ],
    });

    const headerResult = parseAndroidDtboHeader(padded, padded.length);
    if (!headerResult.ok) throw headerResult.error;

    expect(headerResult.value.limitations).toHaveLength(3);
    expect(headerResult.value.limitations[0]).toContain(
      "16 extra header bytes",
    );
    expect(headerResult.value.limitations[1]).toContain(
      "8 trailing bytes per entry",
    );
    expect(headerResult.value.limitations[2]).toContain("19 trailing bytes");

    const tableSlice = padded.subarray(
      headerResult.value.dtEntriesOffset,
      headerResult.value.dtEntriesOffset + headerResult.value.tableSize,
    );
    const tableResult = parseAndroidDtboEntries(headerResult.value, tableSlice);
    if (!tableResult.ok) throw tableResult.error;

    expect(tableResult.value.entries[0]).toMatchObject({
      flags: 0x8000_0000,
      compression: "none",
      custom: [1, 2, 3],
      dtOffset: 4096,
    });
    expect(tableResult.value.entries[1]).toMatchObject({
      flags: 0x02,
      compression: "gzip",
      custom: [4, 5, 6],
      dtOffset: 8192,
    });
  });

  it("admits large header_size and dt_entry_size within file bounds and entry_table_bytes", () => {
    const largeHeader = buildSyntheticAndroidDtbo({
      headerSize: 65_537,
      entries: [],
    });
    const headerRes = parseAndroidDtboHeader(largeHeader, largeHeader.length);
    if (!headerRes.ok) throw headerRes.error;
    expect(headerRes.value.headerSize).toBe(65_537);
    expect(headerRes.value.limitations[0]).toContain("65505 extra header");

    const largeRow = buildSyntheticAndroidDtbo({
      dtEntrySize: 4097,
      entries: [{ payload: sampleAndroidDtboV0().entries[0]! }],
    });
    const rowRes = parseAndroidDtboHeader(largeRow, largeRow.length);
    if (!rowRes.ok) throw rowRes.error;
    expect(rowRes.value.dtEntrySize).toBe(4097);
    expect(rowRes.value.limitations[0]).toContain("reserves 4097 bytes");
  });

  it("handles empty tables and omits zero-size entries with explicit limitations", () => {
    const emptyHeaderBuf = buildSyntheticAndroidDtbo({
      entries: [],
      dtEntryCount: 0,
    });
    const emptyHeader = parseAndroidDtboHeader(
      emptyHeaderBuf,
      emptyHeaderBuf.length,
    );
    if (!emptyHeader.ok) throw emptyHeader.error;
    const emptyEntries = parseAndroidDtboEntries(
      emptyHeader.value,
      Buffer.alloc(0),
    );
    if (!emptyEntries.ok) throw emptyEntries.error;
    expect(emptyEntries.value.entries).toEqual([]);
    expect(emptyEntries.value.limitations[0]).toContain("dt_entry_count 0");

    const withZero = buildSyntheticAndroidDtbo({
      entries: [
        { payload: Buffer.alloc(0), dtSize: 0, dtOffset: 96 },
        { payload: Buffer.from([0xd0, 0x0d, 0xfe, 0xed, 0, 0, 0, 40]) },
      ],
    });
    const zeroHeader = parseAndroidDtboHeader(withZero, withZero.length);
    if (!zeroHeader.ok) throw zeroHeader.error;
    const parsedZero = parseAndroidDtboEntries(
      zeroHeader.value,
      withZero.subarray(
        zeroHeader.value.dtEntriesOffset,
        zeroHeader.value.dtEntriesOffset + zeroHeader.value.tableSize,
      ),
    );
    if (!parsedZero.ok) throw parsedZero.error;
    expect(parsedZero.value.entries).toHaveLength(1);
    expect(parsedZero.value.entries[0]!.index).toBe(1);
    expect(parsedZero.value.limitations[0]).toContain("declares dt_size 0");
  });

  it("rejects truncated, malformed, and unsupported DTBO headers", () => {
    const shortMagic = parseAndroidDtboHeader(Buffer.from([0xd7, 0xb7]), 2);
    expect(shortMagic.ok).toBe(false);
    if (!shortMagic.ok) {
      expect(shortMagic.error.kind).toBe("truncated");
      expect(shortMagic.error.failure.format).toBe(ANDROID_DTBO_FORMAT);
    }

    const wrongMagic = buildSyntheticAndroidDtbo({ magic: 0xdeadbeef });
    const badMagic = parseAndroidDtboHeader(wrongMagic, wrongMagic.length);
    expect(badMagic.ok).toBe(false);
    if (!badMagic.ok) {
      expect(badMagic.error.kind).toBe("malformed");
      expect(badMagic.error.failure.field).toBe("magic");
    }

    const truncatedHdr = Buffer.from([0xd7, 0xb7, 0xab, 0x1e, 0, 0, 0, 64]);
    const shortHdr = parseAndroidDtboHeader(truncatedHdr, truncatedHdr.length);
    expect(shortHdr.ok).toBe(false);
    if (!shortHdr.ok) {
      expect(shortHdr.error.kind).toBe("truncated");
      expect(shortHdr.error.failure.field).toBe("dt_table_header");
    }

    const unsupportedVer = buildSyntheticAndroidDtbo({
      version: 2,
      entries: [],
    });
    const badVer = parseAndroidDtboHeader(
      unsupportedVer,
      unsupportedVer.length,
    );
    expect(badVer.ok).toBe(false);
    if (!badVer.ok) {
      expect(badVer.error.kind).toBe("unsupported");
      expect(badVer.error.failure.field).toBe("version");
    }

    const smallHdr = buildSyntheticAndroidDtbo({ headerSize: 16, entries: [] });
    const badHdrSize = parseAndroidDtboHeader(smallHdr, smallHdr.length);
    expect(badHdrSize.ok).toBe(false);
    if (!badHdrSize.ok) {
      expect(badHdrSize.error.kind).toBe("malformed");
      expect(badHdrSize.error.failure.field).toBe("header_size");
    }

    const smallTotal = buildSyntheticAndroidDtbo({
      totalSize: 16,
      entries: [],
    });
    const badTotal = parseAndroidDtboHeader(smallTotal, smallTotal.length);
    expect(badTotal.ok).toBe(false);
    if (!badTotal.ok) {
      expect(badTotal.error.kind).toBe("malformed");
      expect(badTotal.error.failure.field).toBe("total_size");
    }

    const full = sampleAndroidDtboV0().image;
    const truncTotal = parseAndroidDtboHeader(
      full.subarray(0, 64),
      full.length - 1,
    );
    expect(truncTotal.ok).toBe(false);
    if (!truncTotal.ok) {
      expect(truncTotal.error.kind).toBe("truncated");
      expect(truncTotal.error.failure.field).toBe("total_size");
    }

    const overlapEntriesOffset = buildSyntheticAndroidDtbo({
      headerSize: 64,
      dtEntriesOffset: 32,
      entries: [],
    });
    const badOffset = parseAndroidDtboHeader(
      overlapEntriesOffset,
      overlapEntriesOffset.length,
    );
    expect(badOffset.ok).toBe(false);
    if (!badOffset.ok) {
      expect(badOffset.error.kind).toBe("malformed");
      expect(badOffset.error.failure.field).toBe("dt_entries_offset");
    }
  });

  it("checks table bounds and truncation before enforcing adjustable reader limits", () => {
    const defaultCount = DEFAULT_ANDROID_DTBO_READER_LIMITS.entry_count;
    const oobCount = Buffer.alloc(64);
    oobCount.writeUInt32BE(ANDROID_DTBO_MAGIC, 0);
    oobCount.writeUInt32BE(64, 4);
    oobCount.writeUInt32BE(32, 8);
    oobCount.writeUInt32BE(32, 12);
    oobCount.writeUInt32BE(defaultCount + 10, 16);
    oobCount.writeUInt32BE(32, 20);
    oobCount.writeUInt32BE(2048, 24);
    oobCount.writeUInt32BE(0, 28);
    const oobRes = parseAndroidDtboHeader(oobCount, oobCount.length);
    expect(oobRes.ok).toBe(false);
    if (!oobRes.ok) {
      expect(oobRes.error.kind).toBe("malformed");
      expect(oobRes.error.failure.field).toBe("dt_entry_count");
    }

    const declaredOverLimit = 32 + (defaultCount + 1) * 32;
    const truncOverLimit = Buffer.alloc(64);
    truncOverLimit.writeUInt32BE(ANDROID_DTBO_MAGIC, 0);
    truncOverLimit.writeUInt32BE(declaredOverLimit, 4);
    truncOverLimit.writeUInt32BE(32, 8);
    truncOverLimit.writeUInt32BE(32, 12);
    truncOverLimit.writeUInt32BE(defaultCount + 1, 16);
    truncOverLimit.writeUInt32BE(32, 20);
    truncOverLimit.writeUInt32BE(2048, 24);
    truncOverLimit.writeUInt32BE(0, 28);
    const truncRes = parseAndroidDtboHeader(
      truncOverLimit,
      truncOverLimit.length,
    );
    expect(truncRes.ok).toBe(false);
    if (!truncRes.ok) {
      expect(truncRes.error.kind).toBe("truncated");
      expect(truncRes.error.failure.field).toBe("total_size");
    }

    const overEntryCount = Buffer.alloc(declaredOverLimit);
    overEntryCount.writeUInt32BE(ANDROID_DTBO_MAGIC, 0);
    overEntryCount.writeUInt32BE(declaredOverLimit, 4);
    overEntryCount.writeUInt32BE(32, 8);
    overEntryCount.writeUInt32BE(32, 12);
    overEntryCount.writeUInt32BE(defaultCount + 1, 16);
    overEntryCount.writeUInt32BE(32, 20);
    const countLimit = parseAndroidDtboHeader(
      overEntryCount,
      overEntryCount.length,
    );
    expect(countLimit.ok).toBe(false);
    if (!countLimit.ok && countLimit.error.failure.kind === "limit") {
      expect(countLimit.error.failure.limit.name).toBe(
        ANDROID_DTBO_LIMITS.entryCount.name,
      );
      expect(countLimit.error.failure.limit.maximum).toBe(defaultCount);
      expect(countLimit.error.failure.limit.required).toBe(defaultCount + 1);
    }

    const admittedRaisedCount = parseAndroidDtboHeader(
      overEntryCount,
      overEntryCount.length,
      {
        ...DEFAULT_ANDROID_DTBO_READER_LIMITS,
        entry_count: defaultCount + 1,
      },
    );
    if (!admittedRaisedCount.ok) throw admittedRaisedCount.error;

    const sample = sampleAndroidDtboV0().image;
    const loweredTableBudget = parseAndroidDtboHeader(sample, sample.length, {
      ...DEFAULT_ANDROID_DTBO_READER_LIMITS,
      entry_table_bytes: 63,
    });
    expect(loweredTableBudget.ok).toBe(false);
    if (
      !loweredTableBudget.ok &&
      loweredTableBudget.error.failure.kind === "limit"
    ) {
      expect(loweredTableBudget.error.failure.limit.name).toBe(
        ANDROID_DTBO_LIMITS.entryTableBytes.name,
      );
      expect(loweredTableBudget.error.failure.limit.maximum).toBe(63);
      expect(loweredTableBudget.error.failure.limit.required).toBe(64);
    }

    const raisedTableBudget = parseAndroidDtboHeader(sample, sample.length, {
      ...DEFAULT_ANDROID_DTBO_READER_LIMITS,
      entry_table_bytes: 64,
    });
    if (!raisedTableBudget.ok) throw raisedTableBudget.error;
  });

  it("accepts entries that share one payload, as mkdtimg writes a repeated file", () => {
    // Hand-built in mkdtimg's layout: header (32), two rows (64), one
    // 16-byte payload at 96 that both rows name.
    const image = Buffer.alloc(112);
    image.writeUInt32BE(0xd7b7ab1e, 0);
    image.writeUInt32BE(112, 4);
    image.writeUInt32BE(32, 8);
    image.writeUInt32BE(32, 12);
    image.writeUInt32BE(2, 16);
    image.writeUInt32BE(32, 20);
    image.writeUInt32BE(2048, 24);
    for (const [row, id] of [
      [32, 7],
      [64, 9],
    ] as const) {
      image.writeUInt32BE(16, row);
      image.writeUInt32BE(96, row + 4);
      image.writeUInt32BE(id, row + 8);
    }
    const header = parseAndroidDtboHeader(image, image.length);
    if (!header.ok) throw header.error;
    const table = parseAndroidDtboEntries(header.value, image.subarray(32, 96));
    if (!table.ok) throw table.error;
    expect(
      table.value.entries.map(({ id, dtOffset }) => [id, dtOffset]),
    ).toEqual([
      [7, 96],
      [9, 96],
    ]);
    expect(table.value.limitations).toContain(
      "DTBO entries 0 and 1 share the stored payload [96, 112).",
    );
    expect(table.value.unaccountedRanges).toEqual([]);
  });

  it("reports bytes inside total_size that nothing claims", () => {
    const image = Buffer.alloc(96);
    image.writeUInt32BE(0xd7b7ab1e, 0);
    image.writeUInt32BE(96, 4);
    image.writeUInt32BE(32, 8);
    image.writeUInt32BE(32, 12);
    image.writeUInt32BE(1, 16);
    image.writeUInt32BE(32, 20);
    image.writeUInt32BE(16, 32);
    image.writeUInt32BE(80, 36);
    const header = parseAndroidDtboHeader(image, image.length);
    if (!header.ok) throw header.error;
    const table = parseAndroidDtboEntries(header.value, image.subarray(32, 64));
    if (!table.ok) throw table.error;
    expect(table.value.unaccountedRanges).toEqual([[64, 80]]);
  });

  it("rejects out-of-bounds and overlapping entry payloads", () => {
    const parseWithEntries = (buf: Buffer) => {
      const hdr = parseAndroidDtboHeader(buf, buf.length);
      if (!hdr.ok) throw hdr.error;
      return parseAndroidDtboEntries(
        hdr.value,
        buf.subarray(
          hdr.value.dtEntriesOffset,
          hdr.value.dtEntriesOffset + hdr.value.tableSize,
        ),
      );
    };

    const overlapsHeader = buildSyntheticAndroidDtbo({
      entries: [{ dtOffset: 16, dtSize: 8, payload: Buffer.alloc(0) }],
      totalSize: 128,
    });
    expect(parseWithEntries(overlapsHeader).ok).toBe(false);

    const overlapsTable = buildSyntheticAndroidDtbo({
      entries: [{ dtOffset: 48, dtSize: 8, payload: Buffer.alloc(0) }],
      totalSize: 128,
    });
    expect(parseWithEntries(overlapsTable).ok).toBe(false);

    const pastTotal = buildSyntheticAndroidDtbo({
      entries: [{ dtOffset: 64, dtSize: 32, payload: Buffer.alloc(0) }],
      totalSize: 80,
    });
    expect(parseWithEntries(pastTotal).ok).toBe(false);

    const overlappingPair = buildSyntheticAndroidDtbo({
      entries: [
        { dtOffset: 96, dtSize: 16, payload: Buffer.alloc(16, 1) },
        { dtOffset: 108, dtSize: 16, payload: Buffer.alloc(16, 2) },
      ],
      totalSize: 140,
    });
    const overlapRes = parseWithEntries(overlappingPair);
    expect(overlapRes.ok).toBe(false);
    if (!overlapRes.ok) {
      expect(overlapRes.error.kind).toBe("malformed");
      expect(overlapRes.error.failure.field).toBe("dt_table_entry_overlap");
    }

    const outOfOrderOverlap = buildSyntheticAndroidDtbo({
      entries: [
        { dtOffset: 120, dtSize: 16, payload: Buffer.alloc(16, 1) },
        { dtOffset: 108, dtSize: 16, payload: Buffer.alloc(16, 2) },
      ],
      totalSize: 160,
    });
    expect(parseWithEntries(outOfOrderOverlap).ok).toBe(false);
  });
});
