import { describe, expect, it } from "vitest";
import { espNvsReportSchema } from "./espNvs.js";
import { computeNvsItemHeaderCrc, espIdfCrc32 } from "./espNvsItemDecoder.js";
import { parseEspNvsPartition } from "./espNvsParser.js";

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
  it("decodes namespaces, primitives, UTF-8 strings, and multi-chunk v2 blobs across pages", () => {
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

    const res = parseEspNvsPartition({
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

  it("flags encrypted or corrupt pages as corrupt_or_encrypted with partial coverage", () => {
    const encrypted = Buffer.alloc(4096);
    for (let i = 0; i < encrypted.length; i += 1) {
      encrypted[i] = (i * 73 + 19) & 0xff;
    }
    const res = parseEspNvsPartition({
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
    expect(res.value.pages[0]?.state).toBe("corrupt_or_encrypted");
    expect(res.value.corrupt_or_encrypted_page_count).toBe(1);
    expect(res.value.coverage.status).toBe("partial");
  });

  it("recovers intact keys following an item header whose span byte was corrupted", () => {
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

    const res = parseEspNvsPartition({
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

  it("reassembles thousands of BLOB_IDX records declaring chunkCount = 255 in linear time", () => {
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
    const res = parseEspNvsPartition({
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
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("rejects an explicit partitionBytes selection that extends past the provided slice", () => {
    const image = Buffer.concat([initActivePage(1), initActivePage(2)]);
    const res = parseEspNvsPartition({
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
});
