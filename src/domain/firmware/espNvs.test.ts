import { setImmediate as yieldTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { espNvsReportSchema } from "./espNvs.js";
import { computeNvsItemHeaderCrc, espIdfCrc32 } from "./espNvsItemDecoder.js";
import { hasEspNvsHeader, parseEspNvsPartition } from "./espNvsParser.js";

const initActivePage = (seqNo: number, versionByte = 0xfe): Buffer => {
  const page = Buffer.alloc(4096, 0xff);
  page.writeUInt32LE(0xffff_fffe, 0); // ACTIVE
  page.writeUInt32LE(seqNo, 4);
  page[8] = versionByte;
  const hdrCrc = espIdfCrc32(page.subarray(4, 28));
  page.writeUInt32LE(hdrCrc, 28);
  return page;
};

const setBitmapWritten = (page: Buffer, slot: number, span = 1): void => {
  for (let i = 0; i < span; i += 1) {
    const idx = slot + i;
    const byteIdx = 32 + (idx >>> 2);
    const shift = (idx & 3) * 2;
    // Clear bit 0 so 0b11 -> 0b10 (WRITTEN)
    page[byteIdx] = page[byteIdx]! & ~(1 << shift);
  }
};

const writeKey = (slot32: Buffer, key: string): void => {
  slot32.fill(0, 8, 24);
  Buffer.from(key, "utf8").copy(slot32, 8, 0, 15);
};

const writeNamespaceSlot = (
  page: Buffer,
  slotIdx: number,
  name: string,
  nsId: number,
): void => {
  const off = 64 + slotIdx * 32;
  const s = page.subarray(off, off + 32);
  s.fill(0xff);
  s[0] = 0;
  s[1] = 0x01;
  s[2] = 1;
  s[3] = 0xff;
  writeKey(s, name);
  s[24] = nsId;
  s.writeUInt32LE(computeNvsItemHeaderCrc(s), 4);
  setBitmapWritten(page, slotIdx, 1);
};

const writeU32Slot = (options: {
  readonly page: Buffer;
  readonly slotIdx: number;
  readonly nsId: number;
  readonly key: string;
  readonly val: number;
}): void => {
  const { page, slotIdx, nsId, key, val } = options;
  const off = 64 + slotIdx * 32;
  const s = page.subarray(off, off + 32);
  s.fill(0xff);
  s[0] = nsId;
  s[1] = 0x04;
  s[2] = 1;
  s[3] = 0xff;
  writeKey(s, key);
  s.writeUInt32LE(val >>> 0, 24);
  s.writeUInt32LE(computeNvsItemHeaderCrc(s), 4);
  setBitmapWritten(page, slotIdx, 1);
};

const writeVarSlot = (options: {
  readonly page: Buffer;
  readonly slotIdx: number;
  readonly nsId: number;
  readonly typeCode: number;
  readonly chunkIndex: number;
  readonly key: string;
  readonly payload: Buffer;
}): number => {
  const { page, slotIdx, nsId, typeCode, chunkIndex, key, payload } = options;
  const dataSlots = Math.max(1, Math.ceil(payload.length / 32));
  const span = 1 + dataSlots;
  const off = 64 + slotIdx * 32;
  const s = page.subarray(off, off + 32);
  s.fill(0xff);
  s[0] = nsId;
  s[1] = typeCode;
  s[2] = span;
  s[3] = chunkIndex;
  writeKey(s, key);
  s.writeUInt16LE(payload.length, 24);
  s.writeUInt16LE(0xffff, 26);
  s.writeUInt32LE(espIdfCrc32(payload), 28);
  s.writeUInt32LE(computeNvsItemHeaderCrc(s), 4);
  payload.copy(page, off + 32);
  setBitmapWritten(page, slotIdx, span);
  return span;
};

describe("parseEspNvsPartition", () => {
  it("decodes namespaces, primitives, UTF-8 strings, and multi-chunk v2 blobs across pages", async () => {
    const p0 = initActivePage(1, 0xfe);
    writeNamespaceSlot(p0, 0, "wifi", 1);
    writeU32Slot({ page: p0, slotIdx: 1, nsId: 1, key: "channel", val: 6 });
    const ssidPayload = Buffer.from("factory-ap\0", "utf8");
    const used = writeVarSlot({
      page: p0,
      slotIdx: 2,
      nsId: 1,
      typeCode: 0x21,
      chunkIndex: 0xff,
      key: "ssid",
      payload: ssidPayload,
    });
    const chunk0 = Buffer.from("0123456789abcdef", "utf8");
    writeVarSlot({
      page: p0,
      slotIdx: 2 + used,
      nsId: 1,
      typeCode: 0x42,
      chunkIndex: 0,
      key: "cert_der",
      payload: chunk0,
    });

    const p1 = initActivePage(2, 0xfe);
    const chunk1 = Buffer.from("fedcba9876543210", "utf8");
    const c1Span = writeVarSlot({
      page: p1,
      slotIdx: 0,
      nsId: 1,
      typeCode: 0x42,
      chunkIndex: 1,
      key: "cert_der",
      payload: chunk1,
    });
    // Write BLOB_IDX (0x48)
    const idxOff = 64 + c1Span * 32;
    const idxSlot = p1.subarray(idxOff, idxOff + 32);
    idxSlot.fill(0xff);
    idxSlot[0] = 1;
    idxSlot[1] = 0x48;
    idxSlot[2] = 1;
    idxSlot[3] = 0xff;
    writeKey(idxSlot, "cert_der");
    idxSlot.writeUInt32LE(chunk0.length + chunk1.length, 24);
    idxSlot[28] = 2; // chunkCount
    idxSlot[29] = 0; // chunkStart
    idxSlot.writeUInt32LE(computeNvsItemHeaderCrc(idxSlot), 4);
    setBitmapWritten(p1, c1Span, 1);

    const p2 = Buffer.alloc(4096, 0xff); // EMPTY page
    const image = Buffer.concat([p0, p1, p2]);

    const res = await parseEspNvsPartition({
      artifact: {
        path: "/tmp/nvs.bin",
        sha256: "a".repeat(64),
        bytes: image.length,
      },
      partitionOffset: 0,
      sliceBytes: image,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(espNvsReportSchema.safeParse(res.value).success).toBe(true);
    expect(res.value.coverage.status).toBe("complete");
    expect(res.value.namespaces).toEqual([
      { namespace_id: 1, name: "wifi", page_index: 0, entry_index: 0 },
    ]);
    expect(res.value.entries).toHaveLength(3);
    expect(res.value.entries[0]).toMatchObject({
      namespace: "wifi",
      key: "channel",
      data_type: "u32",
      value_integer: "6",
      crc_valid: true,
    });
    expect(res.value.entries[1]).toMatchObject({
      namespace: "wifi",
      key: "ssid",
      data_type: "sz",
      value_text: "factory-ap",
      crc_valid: true,
    });
    expect(res.value.entries[2]).toMatchObject({
      namespace: "wifi",
      key: "cert_der",
      data_type: "blob_v2",
      blob_size: 32,
      blob_preview_hex: Buffer.concat([chunk0, chunk1]).toString("hex"),
      completeness: "complete",
      crc_valid: true,
    });
  });

  it("does not decode a page whose header fails CRC32, as whole-flash encryption produces", async () => {
    const encrypted = Buffer.alloc(4096);
    for (let i = 0; i < encrypted.length; i += 1) {
      encrypted[i] = (i * 73 + 19) & 0xff;
    }
    const res = await parseEspNvsPartition({
      artifact: {
        path: "/tmp/enc_nvs.bin",
        sha256: "b".repeat(64),
        bytes: 4096,
      },
      partitionOffset: 0,
      sliceBytes: encrypted,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.pages[0]).toMatchObject({
      state: "unknown",
      header_crc_valid: false,
      entries_decoded: false,
    });
    expect(res.value.undecoded_page_count).toBe(1);
    expect(res.value.coverage.status).toBe("partial");
  });

  it("recovers intact keys following an item header whose span byte was corrupted", async () => {
    const page = initActivePage(1, 0xfe);
    writeNamespaceSlot(page, 0, "wifi", 1);
    // Slot 1..2: 2-slot string "ssid" ("Hello\0", where 'H' = 0x48 at payload[0]!)
    const used = writeVarSlot({
      page,
      slotIdx: 1,
      nsId: 1,
      typeCode: 0x21,
      chunkIndex: 0xff,
      key: "ssid",
      payload: Buffer.from("HelloWorld\0", "utf8"),
    });
    expect(used).toBe(2);
    // Slot 3: intact primitive key after the string
    writeU32Slot({ page, slotIdx: 3, nsId: 1, key: "channel", val: 11 });

    // Flip bit 6 of the string header's span byte (2 -> 66) without updating item CRC;
    // page-header CRC covers only [4..28), so the page header stays valid.
    const damagedHeaderOffset = 64 + 1 * 32;
    page[damagedHeaderOffset + 2] = 66;

    const res = await parseEspNvsPartition({
      artifact: {
        path: "/tmp/damaged_span.bin",
        sha256: "d".repeat(64),
        bytes: page.length,
      },
      partitionOffset: 0,
      sliceBytes: page,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(espNvsReportSchema.safeParse(res.value).success).toBe(true);
    // Both slot 1 (corrupted header) and slot 2 (unauthenticated string payload) fail header CRC,
    // while slot 3 ("channel" = 11) is still recovered intact without bogus entries.
    expect(res.value.entries).toEqual([
      expect.objectContaining({
        namespace: "wifi",
        key: "channel",
        data_type: "u32",
        entry_index: 3,
        value_integer: "11",
        crc_valid: true,
      }),
    ]);
    expect(res.value.corrupt_entry_count).toBe(2);
    expect(res.value.anomalies).toHaveLength(2);
    expect(res.value.coverage.status).toBe("partial");
  });

  it("reassembles thousands of BLOB_IDX records declaring chunkCount = 255 in linear time", async () => {
    const pages: Buffer[] = [];
    const p0 = initActivePage(1, 0xfe);
    writeNamespaceSlot(p0, 0, "blobns", 1);
    // Populate 40 BLOB_DATA chunks on p0..p1 so chunk lookups exercise non-empty series too.
    let slotCursor = 1;
    let currentPage = p0;
    let seq = 1;
    for (let c = 0; c < 40; c += 1) {
      if (slotCursor + 2 > 126) {
        pages.push(currentPage);
        seq += 1;
        currentPage = initActivePage(seq, 0xfe);
        slotCursor = 0;
      }
      slotCursor += writeVarSlot({
        page: currentPage,
        slotIdx: slotCursor,
        nsId: 1,
        typeCode: 0x42,
        chunkIndex: c,
        key: `k${String(c % 4)}`,
        payload: Buffer.alloc(16, c),
      });
    }
    pages.push(currentPage);

    // Fill 62 additional pages (62 * 126 = 7,812 slots) with BLOB_IDX entries requesting 255 chunks each.
    for (let p = 0; p < 62; p += 1) {
      seq += 1;
      const idxPage = initActivePage(seq, 0xfe);
      for (let slot = 0; slot < 126; slot += 1) {
        const off = 64 + slot * 32;
        const s = idxPage.subarray(off, off + 32);
        s.fill(0xff);
        s[0] = 1;
        s[1] = 0x48;
        s[2] = 1;
        s[3] = 0xff;
        writeKey(s, `k${String(slot % 8)}`);
        s.writeUInt32LE(4080, 24);
        s[28] = 255; // chunkCount
        s[29] = 0; // chunkStart
        s.writeUInt32LE(computeNvsItemHeaderCrc(s), 4);
      }
      setBitmapWritten(idxPage, 0, 126);
      pages.push(idxPage);
    }

    const image = Buffer.concat(pages);
    const started = performance.now();
    const res = await parseEspNvsPartition({
      artifact: {
        path: "/tmp/crafted_blobs.bin",
        sha256: "e".repeat(64),
        bytes: image.length,
      },
      partitionOffset: 0,
      sliceBytes: image,
    });
    const elapsedMs = performance.now() - started;

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // All 7,812 BLOB_IDX entries are retained without an 8,192 or 1,024 parser truncation, in linear time.
    expect(res.value.entries).toHaveLength(62 * 126);
    expect(res.value.coverage.status).toBe("partial");
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("rejects an explicit partitionBytes selection that extends past the provided slice", async () => {
    const image = Buffer.concat([initActivePage(1), initActivePage(2)]);
    const res = await parseEspNvsPartition({
      artifact: {
        path: "/tmp/short_nvs.bin",
        sha256: "f".repeat(64),
        bytes: image.length,
      },
      partitionOffset: 0,
      partitionBytes: 3 * 4096,
      sliceBytes: image,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("malformed");
    expect(res.error.message).toContain("partition_bytes (12288)");
  });

  const parse = async (image: Buffer) => {
    const res = await parseEspNvsPartition({
      artifact: {
        path: "/tmp/nvs.bin",
        sha256: "c".repeat(64),
        bytes: image.length,
      },
      partitionOffset: 0,
      sliceBytes: image,
    });
    if (!res.ok) throw new Error(res.error.message);
    expect(espNvsReportSchema.safeParse(res.value).success).toBe(true);
    return res.value;
  };

  const writeRawSlot = (
    page: Buffer,
    slotIdx: number,
    fields: {
      readonly nsId: number;
      readonly typeCode: number;
      readonly span?: number;
      readonly chunkIndex?: number;
      readonly key: string;
      readonly data: Buffer;
    },
  ): void => {
    const off = 64 + slotIdx * 32;
    const s = page.subarray(off, off + 32);
    s.fill(0xff);
    s[0] = fields.nsId;
    s[1] = fields.typeCode;
    s[2] = fields.span ?? 1;
    s[3] = fields.chunkIndex ?? 0xff;
    writeKey(s, fields.key);
    fields.data.copy(s, 24, 0, 8);
    s.writeUInt32LE(computeNvsItemHeaderCrc(s), 4);
    setBitmapWritten(page, slotIdx, fields.span ?? 1);
  };

  it("decodes float and double items, which ESP-IDF stores as 0x24 and 0x28", async () => {
    const page = initActivePage(1);
    writeNamespaceSlot(page, 0, "cal", 1);
    const f = Buffer.alloc(8, 0xff);
    f.writeFloatLE(1.5, 0);
    writeRawSlot(page, 1, { nsId: 1, typeCode: 0x24, key: "gain", data: f });
    const d = Buffer.alloc(8);
    d.writeDoubleLE(-0.1, 0);
    writeRawSlot(page, 2, { nsId: 1, typeCode: 0x28, key: "offset", data: d });
    const u64 = Buffer.alloc(8);
    u64.writeBigUInt64LE(0xfedc_ba98_7654_3210n, 0);
    writeRawSlot(page, 3, {
      nsId: 1,
      typeCode: 0x08,
      key: "serial",
      data: u64,
    });
    const i64 = Buffer.alloc(8);
    i64.writeBigInt64LE(-9_007_199_254_740_993n, 0);
    writeRawSlot(page, 4, { nsId: 1, typeCode: 0x18, key: "delta", data: i64 });
    const report = await parse(page);
    expect(report.entries).toEqual([
      expect.objectContaining({
        key: "gain",
        data_type: "float",
        value_float: "1.5",
        value_integer: null,
      }),
      expect.objectContaining({
        key: "offset",
        data_type: "double",
        value_float: "-0.1",
      }),
      expect.objectContaining({
        key: "serial",
        data_type: "u64",
        value_integer: String(0xfedc_ba98_7654_3210n),
      }),
      expect.objectContaining({
        key: "delta",
        data_type: "i64",
        value_integer: "-9007199254740993",
      }),
    ]);
    expect(report.coverage.status).toBe("complete");
  });

  it("distinguishes ESP-IDF page states and does not decode a page firmware marked CORRUPT", async () => {
    const corrupt = initActivePage(3);
    writeNamespaceSlot(corrupt, 0, "wifi", 1);
    corrupt.writeUInt32LE(0xffff_fff0, 0); // CORRUPT; the header CRC excludes the state
    const freeing = initActivePage(4);
    freeing.writeUInt32LE(0xffff_fff8, 0);
    const report = await parse(Buffer.concat([corrupt, freeing]));
    expect(
      report.pages.map((page) => [page.state, page.entries_decoded]),
    ).toEqual([
      ["corrupt", false],
      ["freeing", true],
    ]);
    expect(report.namespaces).toEqual([]);
    expect(report.undecoded_page_count).toBe(1);
    expect(report.anomalies.join("\n")).toContain("firmware marked it CORRUPT");
  });

  it("reports a valid page whose every item header is unreadable as consistent with NVS encryption", async () => {
    const page = initActivePage(1);
    // NVS encryption keeps the header and bitmap in plaintext and encrypts entries.
    for (let i = 64; i < 64 + 3 * 32; i += 1) page[i] = (i * 151 + 7) & 0xff;
    setBitmapWritten(page, 0, 3);
    const report = await parse(page);
    expect(report.pages[0]).toMatchObject({
      state: "active",
      header_crc_valid: true,
      entries_decoded: true,
      inconsistent_item_count: 3,
    });
    expect(report.entries).toEqual([]);
    expect(report.anomalies.at(-1)).toContain(
      "consistent with an encrypted NVS partition",
    );
    expect(report.coverage.status).toBe("partial");
  });

  it("does not trust a CRC-valid header that breaks ESP-IDF's consistency rules", async () => {
    const page = initActivePage(1);
    writeNamespaceSlot(page, 0, "app", 1);
    // A string whose span (5) disagrees with its 10 data bytes (expected 2).
    const data = Buffer.alloc(8, 0xff);
    data.writeUInt16LE(10, 0);
    writeRawSlot(page, 1, {
      nsId: 1,
      typeCode: 0x21,
      span: 5,
      key: "name",
      data,
    });
    writeU32Slot({ page, slotIdx: 2, nsId: 1, key: "after", val: 7 });
    // An unrecognized type is invalid, not an entry with an unknown value.
    writeRawSlot(page, 6, {
      nsId: 1,
      typeCode: 0x99,
      key: "odd",
      data: Buffer.alloc(8),
    });
    const report = await parse(page);
    expect(report.entries.map((entry) => entry.key)).toEqual(["after"]);
    // Slot 1, its three unwritten "payload" slots 3..5 marked written by the
    // bitmap, and slot 6 are all untrusted; slot 2 is still recovered.
    expect(report.pages[0]?.inconsistent_item_count).toBe(5);
    expect(report.anomalies.join("\n")).toMatch(
      /declares span 5 for 10 data bytes \(expected 2\)/u,
    );
    expect(report.anomalies.join("\n")).toContain(
      "unrecognized item type 0x99",
    );
  });

  it("marks older copies of a key superseded by a newer page or a later slot", async () => {
    const older = initActivePage(7);
    older.writeUInt32LE(0xffff_fff8, 0); // FREEING: its items were copied forward
    writeNamespaceSlot(older, 0, "wifi", 1);
    writeU32Slot({ page: older, slotIdx: 1, nsId: 1, key: "channel", val: 1 });
    const newer = initActivePage(8);
    writeU32Slot({ page: newer, slotIdx: 0, nsId: 1, key: "channel", val: 6 });
    writeU32Slot({ page: newer, slotIdx: 1, nsId: 1, key: "power", val: 10 });
    writeU32Slot({ page: newer, slotIdx: 2, nsId: 1, key: "power", val: 20 });
    const report = await parse(Buffer.concat([older, newer]));
    expect(
      report.entries.map((entry) => [
        entry.key,
        entry.value_integer,
        entry.superseded,
      ]),
    ).toEqual([
      ["channel", "1", true],
      ["channel", "6", false],
      ["power", "10", true],
      ["power", "20", false],
    ]);
  });

  it("keeps the bytes of a non-UTF-8 string and key instead of replacing them", async () => {
    const page = initActivePage(1);
    writeNamespaceSlot(page, 0, "raw", 1);
    writeVarSlot({
      page,
      slotIdx: 1,
      nsId: 1,
      typeCode: 0x21,
      chunkIndex: 0xff,
      key: "bin",
      payload: Buffer.from([0xc3, 0x28, 0x00]),
    });
    const report = await parse(page);
    expect(report.entries[0]).toMatchObject({
      data_type: "sz",
      value_text: null,
      blob_size: 3,
      blob_preview_hex: "c32800",
    });
    expect(report.anomalies.join("\n")).toContain("not valid UTF-8");
  });

  it("keeps UTF-8 and Latin-1 keys with identical display text separate in superseding and v2 blob reassembly", async () => {
    const page = initActivePage(1);
    writeNamespaceSlot(page, 0, "i18n", 1);

    const writeKeyBytesSlot = (
      slotIdx: number,
      fields: {
        readonly typeCode: number;
        readonly span: number;
        readonly chunkIndex: number;
        readonly keyBytes: readonly number[];
        readonly data8: Buffer;
        readonly payload?: Buffer;
      },
    ): void => {
      const off = 64 + slotIdx * 32;
      const s = page.subarray(off, off + 32);
      s.fill(0xff);
      s[0] = 1;
      s[1] = fields.typeCode;
      s[2] = fields.span;
      s[3] = fields.chunkIndex;
      s.fill(0, 8, 24);
      Buffer.from(fields.keyBytes).copy(s, 8);
      fields.data8.copy(s, 24, 0, 8);
      s.writeUInt32LE(computeNvsItemHeaderCrc(s), 4);
      if (fields.payload !== undefined) fields.payload.copy(page, off + 32);
      setBitmapWritten(page, slotIdx, fields.span);
    };

    // Stored key bytes [0xc3, 0xa9, 0x00] (UTF-8 "é") vs [0xe9, 0x00] (Latin-1 "é").
    const utf8Key = [0xc3, 0xa9, 0x00];
    const latin1Key = [0xe9, 0x00];

    const u32A = Buffer.alloc(8, 0xff);
    u32A.writeUInt32LE(100, 0);
    writeKeyBytesSlot(1, {
      typeCode: 0x04,
      span: 1,
      chunkIndex: 0xff,
      keyBytes: utf8Key,
      data8: u32A,
    });
    const u32B = Buffer.alloc(8, 0xff);
    u32B.writeUInt32LE(200, 0);
    writeKeyBytesSlot(2, {
      typeCode: 0x04,
      span: 1,
      chunkIndex: 0xff,
      keyBytes: latin1Key,
      data8: u32B,
    });

    // Two distinct v2 blobs in the same namespace with chunkIndex 0 under the two byte keys.
    const utf8Chunk = Buffer.from("utf8-blob", "utf8");
    const utf8ChunkData8 = Buffer.alloc(8, 0xff);
    utf8ChunkData8.writeUInt16LE(utf8Chunk.length, 0);
    utf8ChunkData8.writeUInt32LE(espIdfCrc32(utf8Chunk), 4);
    writeKeyBytesSlot(3, {
      typeCode: 0x42,
      span: 2,
      chunkIndex: 0,
      keyBytes: utf8Key,
      data8: utf8ChunkData8,
      payload: utf8Chunk,
    });

    const latin1Chunk = Buffer.from("latin1-blob", "utf8");
    const latin1ChunkData8 = Buffer.alloc(8, 0xff);
    latin1ChunkData8.writeUInt16LE(latin1Chunk.length, 0);
    latin1ChunkData8.writeUInt32LE(espIdfCrc32(latin1Chunk), 4);
    writeKeyBytesSlot(5, {
      typeCode: 0x42,
      span: 2,
      chunkIndex: 0,
      keyBytes: latin1Key,
      data8: latin1ChunkData8,
      payload: latin1Chunk,
    });

    const utf8Idx = Buffer.alloc(8, 0xff);
    utf8Idx.writeUInt32LE(utf8Chunk.length, 0);
    utf8Idx[4] = 1;
    utf8Idx[5] = 0;
    writeKeyBytesSlot(7, {
      typeCode: 0x48,
      span: 1,
      chunkIndex: 0xff,
      keyBytes: utf8Key,
      data8: utf8Idx,
    });

    const latin1Idx = Buffer.alloc(8, 0xff);
    latin1Idx.writeUInt32LE(latin1Chunk.length, 0);
    latin1Idx[4] = 1;
    latin1Idx[5] = 0;
    writeKeyBytesSlot(8, {
      typeCode: 0x48,
      span: 1,
      chunkIndex: 0xff,
      keyBytes: latin1Key,
      data8: latin1Idx,
    });

    const report = await parse(page);
    expect(report.entries).toEqual([
      expect.objectContaining({
        entry_index: 1,
        key: "é",
        data_type: "u32",
        value_integer: "100",
        superseded: false,
      }),
      expect.objectContaining({
        entry_index: 2,
        key: "é",
        data_type: "u32",
        value_integer: "200",
        superseded: false,
      }),
      expect.objectContaining({
        entry_index: 7,
        key: "é",
        data_type: "blob_v2",
        blob_preview_hex: utf8Chunk.toString("hex"),
        completeness: "complete",
        superseded: false,
      }),
      expect.objectContaining({
        entry_index: 8,
        key: "é",
        data_type: "blob_v2",
        blob_preview_hex: latin1Chunk.toString("hex"),
        completeness: "complete",
        superseded: false,
      }),
    ]);
  });

  it("rejects a multi-slot item whose continuation slot is not marked written and recovers later slots", async () => {
    const page = initActivePage(1);
    writeNamespaceSlot(page, 0, "wifi", 1);
    // 3-slot string at slots 1..3 (>32 payload bytes) whose payload CRC32 is valid.
    const payload = Buffer.from(`${"A".repeat(40)}\0`, "utf8");
    const span = writeVarSlot({
      page,
      slotIdx: 1,
      nsId: 1,
      typeCode: 0x21,
      chunkIndex: 0xff,
      key: "unfinished",
      payload,
    });
    expect(span).toBe(3);

    // Leave continuation slot 2 in EMPTY (0b11) state while placing a valid u32 item at slot 3.
    const slot2Byte = 32 + (2 >>> 2);
    const slot2Shift = (2 & 3) * 2;
    page[slot2Byte] = page[slot2Byte]! | (3 << slot2Shift);
    writeU32Slot({ page, slotIdx: 3, nsId: 1, key: "intact", val: 42 });

    const report = await parse(page);
    expect(report.entries).toEqual([
      expect.objectContaining({
        namespace: "wifi",
        key: "intact",
        entry_index: 3,
        data_type: "u32",
        value_integer: "42",
      }),
    ]);
    expect(report.corrupt_entry_count).toBe(1);
    expect(report.coverage.status).toBe("partial");
    expect(report.anomalies.join("\n")).toContain(
      "continuation slot 2 has bitmap state empty instead of written",
    );
  });

  it("marks coverage partial when v2 blob chunks are missing or bitmap slots are illegal", async () => {
    const missingBlobPage = initActivePage(1);
    writeNamespaceSlot(missingBlobPage, 0, "cfg", 1);
    const idxData = Buffer.alloc(8, 0xff);
    idxData.writeUInt32LE(16, 0);
    idxData[4] = 1; // chunkCount = 1, with no BLOB_DATA present
    idxData[5] = 0;
    writeRawSlot(missingBlobPage, 1, {
      nsId: 1,
      typeCode: 0x48,
      key: "cert",
      data: idxData,
    });
    const missingBlobReport = await parse(missingBlobPage);
    expect(missingBlobReport.entries[0]?.completeness).toBe("missing_chunks");
    expect(missingBlobReport.coverage.status).toBe("partial");

    const illegalSlotPage = initActivePage(1);
    writeNamespaceSlot(illegalSlotPage, 0, "cfg", 1);
    writeU32Slot({
      page: illegalSlotPage,
      slotIdx: 1,
      nsId: 1,
      key: "ok",
      val: 1,
    });
    // Set slot 2 bitmap bits to 0b01 (ILLEGAL): clear bit 1 from 0b11.
    const shift = (2 & 3) * 2;
    illegalSlotPage[32] = illegalSlotPage[32]! & ~(2 << shift);
    const illegalReport = await parse(illegalSlotPage);
    expect(illegalReport.pages[0]?.illegal_slot_count).toBe(1);
    expect(illegalReport.coverage.status).toBe("partial");
  });

  it("yields cooperatively between page batches so scheduled cancellation aborts mid-decode", async () => {
    const pages = Array.from({ length: 48 }, (_, idx) =>
      initActivePage(idx + 1),
    );
    const image = Buffer.concat(pages);
    let aborted = false;
    let checkpoints = 0;
    void yieldTurn().then(() => {
      aborted = true;
    });

    await expect(
      parseEspNvsPartition({
        artifact: {
          path: "/tmp/large_nvs.bin",
          sha256: "9".repeat(64),
          bytes: image.length,
        },
        partitionOffset: 0,
        sliceBytes: image,
        onCheckpoint: () => {
          checkpoints += 1;
          if (aborted) throw new Error("cancelled-mid-decode");
        },
      }),
    ).rejects.toThrow("cancelled-mid-decode");
    expect(checkpoints).toBeGreaterThan(16);
    expect(checkpoints).toBeLessThan(48);
  });

  it("recognizes only page-aligned partitions with a valid ESP-IDF NVS page header", () => {
    const valid = initActivePage(1, 0xfe);
    expect(hasEspNvsHeader(valid, valid.length)).toBe(true);
    expect(hasEspNvsHeader(valid, valid.length + 16)).toBe(false);
    expect(hasEspNvsHeader(Buffer.alloc(4096, 0xff), 4096)).toBe(false);
    const badReserved = Buffer.from(valid);
    badReserved[12] = 0;
    badReserved.writeUInt32LE(espIdfCrc32(badReserved.subarray(4, 28)), 28);
    expect(hasEspNvsHeader(badReserved, 4096)).toBe(false);
  });

  it("keeps intact earlier settings active when a newer rewrite is damaged, skips unsupported page versions, handles copied BLOB_DATA chunks, and preserves -0 floats", async () => {
    // Page 0 (seq 1): namespace "cfg"=1, intact string "host"="good", float "-0" and "+0", and BLOB_DATA chunk 0 copy
    const p0 = initActivePage(1, 0xfe);
    writeNamespaceSlot(p0, 0, "cfg", 1);
    const spanGood = writeVarSlot({
      page: p0,
      slotIdx: 1,
      nsId: 1,
      typeCode: 0x21,
      chunkIndex: 0xff,
      key: "host",
      payload: Buffer.from("good\0", "utf8"),
    });
    // Float -0.0 (0x80000000) and Double -0.0
    const fNegSlotOff = 64 + (1 + spanGood) * 32;
    const fNeg = p0.subarray(fNegSlotOff, fNegSlotOff + 32);
    fNeg.fill(0xff);
    fNeg[0] = 1;
    fNeg[1] = 0x24; // FLOAT
    fNeg[2] = 1;
    fNeg[3] = 0xff;
    writeKey(fNeg, "f_neg_zero");
    fNeg.writeFloatLE(-0, 24);
    fNeg.writeUInt32LE(computeNvsItemHeaderCrc(fNeg), 4);
    setBitmapWritten(p0, 1 + spanGood, 1);

    const dNegSlotOff = fNegSlotOff + 32;
    const dNeg = p0.subarray(dNegSlotOff, dNegSlotOff + 32);
    dNeg.fill(0xff);
    dNeg[0] = 1;
    dNeg[1] = 0x28; // DOUBLE
    dNeg[2] = 1;
    dNeg[3] = 0xff;
    writeKey(dNeg, "d_neg_zero");
    dNeg.writeDoubleLE(-0, 24);
    dNeg.writeUInt32LE(computeNvsItemHeaderCrc(dNeg), 4);
    setBitmapWritten(p0, 2 + spanGood, 1);

    const blobChunkPayload = Buffer.from("copied-chunk-bytes", "utf8");
    writeVarSlot({
      page: p0,
      slotIdx: 3 + spanGood,
      nsId: 1,
      typeCode: 0x42, // BLOB_DATA (older page-move copy)
      chunkIndex: 0,
      key: "moved_blob",
      payload: blobChunkPayload,
    });

    // Page 1 (seq 2): copied BLOB_DATA chunk 0 + matching BLOB_IDX (complete page move before freeing p0)
    const p1 = initActivePage(2, 0xfe);
    const cSpan = writeVarSlot({
      page: p1,
      slotIdx: 0,
      nsId: 1,
      typeCode: 0x42,
      chunkIndex: 0,
      key: "moved_blob",
      payload: blobChunkPayload,
    });
    const idxOff = 64 + cSpan * 32;
    const idxSlot = p1.subarray(idxOff, idxOff + 32);
    idxSlot.fill(0xff);
    idxSlot[0] = 1;
    idxSlot[1] = 0x48; // BLOB_IDX
    idxSlot[2] = 1;
    idxSlot[3] = 0xff;
    writeKey(idxSlot, "moved_blob");
    idxSlot.writeUInt32LE(blobChunkPayload.length, 24);
    idxSlot[28] = 1; // chunkCount
    idxSlot[29] = 0; // chunkStart
    idxSlot.writeUInt32LE(computeNvsItemHeaderCrc(idxSlot), 4);
    setBitmapWritten(p1, cSpan, 1);

    // Check 1: [p0, p1] alone has complete coverage and zero orphan chunks despite duplicate BLOB_DATA
    const cleanMove = await parseEspNvsPartition({
      artifact: { path: "/tmp/move.bin", sha256: "a".repeat(64), bytes: 8192 },
      partitionOffset: 0,
      sliceBytes: Buffer.concat([p0, p1]),
    });
    expect(cleanMove.ok).toBe(true);
    if (!cleanMove.ok) return;
    expect(cleanMove.value.coverage.status).toBe("complete");
    expect(
      cleanMove.value.entries.filter((e) => e.data_type === "blob_data_orphan"),
    ).toHaveLength(0);
    expect(
      cleanMove.value.entries.find((e) => e.key === "f_neg_zero")?.value_float,
    ).toBe("-0");
    expect(
      cleanMove.value.entries.find((e) => e.key === "d_neg_zero")?.value_float,
    ).toBe("-0");

    // Page 2 (seq 3): damaged string rewrite of "host" (corrupted payload byte -> crc_mismatch)
    const p2 = initActivePage(3, 0xfe);
    writeVarSlot({
      page: p2,
      slotIdx: 0,
      nsId: 1,
      typeCode: 0x21,
      chunkIndex: 0xff,
      key: "host",
      payload: Buffer.from("corrupt\0", "utf8"),
    });
    p2[64 + 32] = p2[64 + 32]! ^ 0xff; // corrupt string payload byte

    // Page 3 (seq 4): unsupported formatVersion 0xfd with valid header CRC
    const p3 = initActivePage(4, 0xfd);

    const full = await parseEspNvsPartition({
      artifact: {
        path: "/tmp/mixed.bin",
        sha256: "b".repeat(64),
        bytes: 16384,
      },
      partitionOffset: 0,
      sliceBytes: Buffer.concat([p0, p1, p2, p3]),
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(espNvsReportSchema.safeParse(full.value).success).toBe(true);
    expect(full.value.coverage.status).toBe("partial");
    expect(full.value.pages[3]?.format_version).toBe("unknown");
    expect(full.value.pages[3]?.entries_decoded).toBe(false);
    expect(full.value.undecoded_page_count).toBe(1);

    const hostEntries = full.value.entries.filter((e) => e.key === "host");
    expect(hostEntries).toHaveLength(2);
    expect(hostEntries[0]).toMatchObject({
      value_text: "good",
      completeness: "complete",
      superseded: false,
    });
    expect(hostEntries[1]).toMatchObject({
      completeness: "crc_mismatch",
      superseded: false,
    });
  });

  it("reports an older copy of a used blob chunk as a superseded copy", async () => {
    const chunk = Buffer.from("0123456789abcdef");
    const writeChunk = (page: Buffer, slot: number) =>
      writeVarSlot({
        page,
        slotIdx: slot,
        nsId: 1,
        typeCode: 0x42,
        chunkIndex: 0,
        key: "cert",
        payload: chunk,
      });
    const older = initActivePage(5);
    older.writeUInt32LE(0xffff_fff8, 0); // FREEING: being copied forward
    writeNamespaceSlot(older, 0, "tls", 1);
    writeChunk(older, 1);
    const newer = initActivePage(6);
    writeChunk(newer, 0);
    const idx = Buffer.alloc(8, 0xff);
    idx.writeUInt32LE(chunk.length, 0);
    idx[4] = 1;
    idx[5] = 0;
    writeRawSlot(newer, 2, { nsId: 1, typeCode: 0x48, key: "cert", data: idx });
    const report = await parse(Buffer.concat([older, newer]));
    expect(
      report.entries.map((entry) => [
        entry.data_type,
        entry.page_index,
        entry.completeness,
        entry.superseded,
      ]),
    ).toEqual([
      ["blob_data_copy", 0, "complete", true],
      ["blob_v2", 1, "complete", false],
    ]);
    expect(report.coverage.status).toBe("complete");
  });

  it("keeps an intact older blob chunk unsuperseded when the newer chunk copy fails CRC", async () => {
    const chunk = Buffer.from("0123456789abcdef");
    const older = initActivePage(5);
    older.writeUInt32LE(0xffff_fff8, 0);
    writeNamespaceSlot(older, 0, "tls", 1);
    writeVarSlot({
      page: older,
      slotIdx: 1,
      nsId: 1,
      typeCode: 0x42,
      chunkIndex: 0,
      key: "cert",
      payload: chunk,
    });
    const newer = initActivePage(6);
    writeVarSlot({
      page: newer,
      slotIdx: 0,
      nsId: 1,
      typeCode: 0x42,
      chunkIndex: 0,
      key: "cert",
      payload: chunk,
    });
    newer[64 + 32] = newer[64 + 32]! ^ 0xff; // corrupt newer chunk payload
    const idx = Buffer.alloc(8, 0xff);
    idx.writeUInt32LE(chunk.length, 0);
    idx[4] = 1;
    idx[5] = 0;
    writeRawSlot(newer, 2, { nsId: 1, typeCode: 0x48, key: "cert", data: idx });
    const report = await parse(Buffer.concat([older, newer]));
    expect(
      report.entries.map((entry) => [
        entry.data_type,
        entry.page_index,
        entry.completeness,
        entry.superseded,
      ]),
    ).toEqual([
      ["blob_data_copy", 0, "complete", false],
      ["blob_v2", 1, "crc_mismatch", false],
    ]);
    expect(report.coverage.status).toBe("partial");
  });

  it("refuses dense NVS representations before unchecked entry or anomaly growth exceeds max_decoded_bytes", async () => {
    const dense = initActivePage(1, 0xfe);
    writeNamespaceSlot(dense, 0, "cfg", 1);
    for (let slot = 1; slot < 64; slot += 1) {
      writeU32Slot({
        page: dense,
        slotIdx: slot,
        nsId: 1,
        key: `k_${String(slot)}`,
        val: slot,
      });
    }
    const refused = await parseEspNvsPartition({
      artifact: {
        path: "/tmp/dense.bin",
        sha256: "e".repeat(64),
        bytes: dense.length,
      },
      partitionOffset: 0,
      sliceBytes: dense,
      maxDecodedBytes: 4096,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.failure.kind === "limit") {
      expect(refused.error.failure.limit).toEqual({
        name: "max_decoded_bytes",
        maximum: 4096,
      });
    }
  });
});
