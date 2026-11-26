import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import {
  readInt32At,
  readInt64At,
  readUint16At,
  readUint32At,
  readUint64At,
} from "../binaryContainer.js";
import type { EspNvsDataType, EspNvsEntry } from "./espNvs.js";

const CRC_SEED = 0xffff_ffff;
const MAX_BLOB_PREVIEW_BYTES = 128;
const EMPTY_SHA256 = sha256Hex(Buffer.alloc(0));

/** Compute ESP-IDF `esp_rom_crc32_le(0xffffffff, buf, len)`. */
export const espIdfCrc32 = (bytes: Uint8Array): number =>
  crc32(bytes, CRC_SEED) >>> 0;

/** Compute ESP-IDF NVS 32-byte item header CRC over `[0..4) || [8..32)`. */
export const computeNvsItemHeaderCrc = (slot32: Uint8Array): number => {
  const packed = Buffer.allocUnsafe(28);
  packed.set(slot32.subarray(0, 4), 0);
  packed.set(slot32.subarray(8, 32), 4);
  return espIdfCrc32(packed);
};

export const decodeCString16 = (bytes16: Uint8Array): string => {
  const nul = bytes16.indexOf(0);
  const slice = nul === -1 ? bytes16 : bytes16.subarray(0, nul);
  return Buffer.from(slice).toString("utf8");
};

export interface RawBlobChunk {
  readonly pageIndex: number;
  readonly pageSeqNo: number;
  readonly entryIndex: number;
  readonly fileOffset: number;
  readonly nsIndex: number;
  readonly key: string;
  readonly chunkIndex: number;
  readonly span: number;
  readonly payload: Buffer;
  readonly crcValid: boolean;
}

export interface RawBlobIndex {
  readonly pageIndex: number;
  readonly pageSeqNo: number;
  readonly entryIndex: number;
  readonly fileOffset: number;
  readonly nsIndex: number;
  readonly key: string;
  readonly totalSize: number;
  readonly chunkCount: number;
  readonly chunkStart: number;
  readonly headerCrcValid: boolean;
}

const decodePrimitiveValue = (
  typeCode: number,
  data8: Uint8Array,
): {
  readonly dataType: EspNvsDataType;
  readonly integerText: string;
} | null => {
  switch (typeCode) {
    case 0x01:
      return { dataType: "u8", integerText: String(data8[0]!) };
    case 0x11: {
      const v = data8[0]!;
      return { dataType: "i8", integerText: String(v > 127 ? v - 256 : v) };
    }
    case 0x02:
      return {
        dataType: "u16",
        integerText: String(readUint16At(data8, 0, true)),
      };
    case 0x12: {
      const u = readUint16At(data8, 0, true);
      return {
        dataType: "i16",
        integerText: String(u > 32767 ? u - 65536 : u),
      };
    }
    case 0x04:
      return {
        dataType: "u32",
        integerText: String(readUint32At(data8, 0, true)),
      };
    case 0x14:
      return {
        dataType: "i32",
        integerText: String(readInt32At(data8, 0, true)),
      };
    case 0x08:
      return {
        dataType: "u64",
        integerText: readUint64At(data8, 0, true).toString(10),
      };
    case 0x18:
      return {
        dataType: "i64",
        integerText: readInt64At(data8, 0, true).toString(10),
      };
    default:
      return null;
  }
};

export interface DecodedSingleSlotResult {
  readonly consumedSlots: number;
  readonly namespaceDef?: {
    readonly id: number;
    readonly name: string;
    readonly pageIndex: number;
    readonly entryIndex: number;
  };
  readonly immediateEntry?: Omit<EspNvsEntry, "namespace">;
  readonly blobChunk?: RawBlobChunk;
  readonly blobIndex?: RawBlobIndex;
  readonly crcMismatch?: boolean;
  readonly anomaly?: string;
}

const entryCompleteness = (
  crcValid: boolean,
  chunksComplete: boolean,
): EspNvsEntry["completeness"] => {
  if (!crcValid) return "crc_mismatch";
  if (!chunksComplete) return "missing_chunks";
  return "complete";
};

const buildImmediateVariableEntry = (options: {
  readonly pageIndex: number;
  readonly pageFileOffset: number;
  readonly entryIndex: number;
  readonly nsIndex: number;
  readonly typeCode: number;
  readonly span: number;
  readonly key: string;
  readonly payload: Buffer;
  readonly crcValid: boolean;
}): DecodedSingleSlotResult => {
  const {
    pageIndex,
    pageFileOffset,
    entryIndex,
    nsIndex,
    typeCode,
    span,
    key,
    payload,
    crcValid,
  } = options;
  const fileOffset = pageFileOffset + 64 + entryIndex * 32;
  const payloadAnomaly = crcValid
    ? {}
    : {
        crcMismatch: true,
        anomaly: `Page ${String(pageIndex)} slot ${String(entryIndex)} at offset 0x${fileOffset.toString(16)} ("${key}") failed variable-payload CRC32 or length check.`,
      };
  if (typeCode === 0x21) {
    const nulIdx = payload.indexOf(0);
    const strBytes = nulIdx === -1 ? payload : payload.subarray(0, nulIdx);
    return {
      consumedSlots: span,
      immediateEntry: {
        page_index: pageIndex,
        entry_index: entryIndex,
        file_offset: fileOffset,
        namespace_id: nsIndex,
        key,
        data_type: "sz",
        raw_type_code: typeCode,
        span,
        value_text: strBytes.toString("utf8"),
        value_integer: null,
        blob_size: null,
        blob_preview_hex: null,
        blob_sha256: null,
        crc_valid: crcValid,
        completeness: entryCompleteness(crcValid, true),
      },
      ...payloadAnomaly,
    };
  }
  const preview = payload.subarray(0, MAX_BLOB_PREVIEW_BYTES).toString("hex");
  return {
    consumedSlots: span,
    immediateEntry: {
      page_index: pageIndex,
      entry_index: entryIndex,
      file_offset: fileOffset,
      namespace_id: nsIndex,
      key,
      data_type: "blob_v1",
      raw_type_code: typeCode,
      span,
      value_text: null,
      value_integer: null,
      blob_size: payload.length,
      blob_preview_hex: preview,
      blob_sha256: sha256Hex(payload),
      crc_valid: crcValid,
      completeness: entryCompleteness(crcValid, true),
    },
    ...payloadAnomaly,
  };
};

const decodeVariableSpanItem = (options: {
  readonly pageBytes: Buffer;
  readonly pageIndex: number;
  readonly pageSeqNo: number;
  readonly pageFileOffset: number;
  readonly entryIndex: number;
  readonly nsIndex: number;
  readonly typeCode: number;
  readonly span: number;
  readonly chunkIndex: number;
  readonly key: string;
  readonly data8: Uint8Array;
}): DecodedSingleSlotResult => {
  const {
    pageBytes,
    pageIndex,
    pageSeqNo,
    pageFileOffset,
    entryIndex,
    nsIndex,
    typeCode,
    span,
    chunkIndex,
    key,
    data8,
  } = options;
  const declaredLen = readUint16At(data8, 0, true);
  const declaredDataCrc = readUint32At(data8, 4, true);
  const maxSpanBytes = (span - 1) * 32;
  const payloadStart = 64 + (entryIndex + 1) * 32;
  const availableBytes = Math.max(
    0,
    Math.min(maxSpanBytes, 4096 - payloadStart),
  );
  const sliceLen = Math.min(declaredLen, availableBytes);
  const payload = Buffer.from(
    pageBytes.subarray(payloadStart, payloadStart + sliceLen),
  );
  const crcValid =
    sliceLen === declaredLen && espIdfCrc32(payload) === declaredDataCrc;
  const fileOffset = pageFileOffset + 64 + entryIndex * 32;

  if (typeCode === 0x42) {
    return {
      consumedSlots: span,
      blobChunk: {
        pageIndex,
        pageSeqNo,
        entryIndex,
        fileOffset,
        nsIndex,
        key,
        chunkIndex,
        span,
        payload,
        crcValid,
      },
      ...(crcValid
        ? {}
        : {
            crcMismatch: true,
            anomaly: `Page ${String(pageIndex)} slot ${String(entryIndex)} at offset 0x${fileOffset.toString(16)} ("${key}" chunk ${String(chunkIndex)}) failed BLOB_DATA payload CRC32 or length check.`,
          }),
    };
  }
  return buildImmediateVariableEntry({
    pageIndex,
    pageFileOffset,
    entryIndex,
    nsIndex,
    typeCode,
    span,
    key,
    payload,
    crcValid,
  });
};

/** Decode one written NVS entry starting at `entryIndex` (0..125). */
export const decodeWrittenNvsSlot = (options: {
  readonly pageBytes: Buffer;
  readonly pageIndex: number;
  readonly pageSeqNo: number;
  readonly pageFileOffset: number;
  readonly entryIndex: number;
}): DecodedSingleSlotResult => {
  const { pageBytes, pageIndex, pageSeqNo, pageFileOffset, entryIndex } =
    options;
  const slotOffset = 64 + entryIndex * 32;
  const slotFileOffset = pageFileOffset + slotOffset;
  const slot = pageBytes.subarray(slotOffset, slotOffset + 32);
  const declaredHeaderCrc = readUint32At(slot, 4, true);
  const headerCrcValid = computeNvsItemHeaderCrc(slot) === declaredHeaderCrc;

  // Never trust span, key, or type fields from an item header whose CRC32 failed:
  // a single flipped bit in `span` would skip subsequent intact entries, and
  // trailing payload slots of a damaged multi-slot item are not item headers.
  if (!headerCrcValid) {
    return {
      consumedSlots: 1,
      crcMismatch: true,
      anomaly: `Page ${String(pageIndex)} slot ${String(entryIndex)} at offset 0x${slotFileOffset.toString(16)} failed item-header CRC32; advancing 1 slot to recover subsequent entries.`,
    };
  }

  const nsIndex = slot[0]!;
  const typeCode = slot[1]!;
  const rawSpan = slot[2]!;
  const maxRemainingSpan = 126 - entryIndex;
  const chunkIndex = slot[3]!;
  const key = decodeCString16(slot.subarray(8, 24));
  const data8 = slot.subarray(24, 32);

  if (nsIndex === 0 && typeCode === 0x01) {
    const nsId = data8[0]!;
    if (rawSpan === 1 && nsId >= 1 && nsId <= 254) {
      return {
        consumedSlots: 1,
        namespaceDef: { id: nsId, name: key, pageIndex, entryIndex },
      };
    }
    return {
      consumedSlots: 1,
      crcMismatch: true,
      anomaly: `Page ${String(pageIndex)} slot ${String(entryIndex)} at offset 0x${slotFileOffset.toString(16)} carries an invalid namespace definition (id=${String(nsId)}, span=${String(rawSpan)}).`,
    };
  }

  if (nsIndex === 0) {
    if (rawSpan < 1 || rawSpan > maxRemainingSpan) {
      return {
        consumedSlots: 1,
        crcMismatch: true,
        anomaly: `Page ${String(pageIndex)} slot ${String(entryIndex)} at offset 0x${slotFileOffset.toString(16)} declares out-of-bounds span ${String(rawSpan)}.`,
      };
    }
    return { consumedSlots: rawSpan };
  }

  if (typeCode === 0x48) {
    if (rawSpan !== 1) {
      return {
        consumedSlots: 1,
        crcMismatch: true,
        anomaly: `Page ${String(pageIndex)} slot ${String(entryIndex)} at offset 0x${slotFileOffset.toString(16)} ("${key}") declares invalid BLOB_IDX span ${String(rawSpan)}.`,
      };
    }
    return {
      consumedSlots: 1,
      blobIndex: {
        pageIndex,
        pageSeqNo,
        entryIndex,
        fileOffset: slotFileOffset,
        nsIndex,
        key,
        totalSize: readUint32At(data8, 0, true),
        chunkCount: data8[4]!,
        chunkStart: data8[5]!,
        headerCrcValid: true,
      },
    };
  }

  if (typeCode === 0x21 || typeCode === 0x41 || typeCode === 0x42) {
    if (rawSpan < 2 || rawSpan > maxRemainingSpan) {
      return {
        consumedSlots: 1,
        crcMismatch: true,
        anomaly: `Page ${String(pageIndex)} slot ${String(entryIndex)} at offset 0x${slotFileOffset.toString(16)} ("${key}") declares invalid variable-item span ${String(rawSpan)}.`,
      };
    }
    return decodeVariableSpanItem({
      pageBytes,
      pageIndex,
      pageSeqNo,
      pageFileOffset,
      entryIndex,
      nsIndex,
      typeCode,
      span: rawSpan,
      chunkIndex,
      key,
      data8,
    });
  }

  const prim = decodePrimitiveValue(typeCode, data8);
  if (prim !== null && rawSpan !== 1) {
    return {
      consumedSlots: 1,
      crcMismatch: true,
      anomaly: `Page ${String(pageIndex)} slot ${String(entryIndex)} at offset 0x${slotFileOffset.toString(16)} ("${key}") declares invalid primitive span ${String(rawSpan)}.`,
    };
  }
  const span = rawSpan >= 1 && rawSpan <= maxRemainingSpan ? rawSpan : 1;
  return {
    consumedSlots: span,
    immediateEntry: {
      page_index: pageIndex,
      entry_index: entryIndex,
      file_offset: slotFileOffset,
      namespace_id: nsIndex,
      key,
      data_type: prim?.dataType ?? "unknown",
      raw_type_code: typeCode,
      span,
      value_text: null,
      value_integer: prim?.integerText ?? null,
      blob_size: null,
      blob_preview_hex: null,
      blob_sha256: null,
      crc_valid: true,
      completeness: "complete",
    },
  };
};

interface ReassembledBlobSummary {
  readonly joinedLength: number;
  readonly previewHex: string;
  readonly sha256: string;
  readonly allPresent: boolean;
  readonly chunksCrcValid: boolean;
}

/** Reassemble v2 multi-chunk `BLOB_IDX` + `BLOB_DATA` items and surface orphan chunks. */
export const reassembleNvsV2Blobs = (
  indices: readonly RawBlobIndex[],
  chunks: readonly RawBlobChunk[],
  onCheckpoint?: () => void,
): Omit<EspNvsEntry, "namespace">[] => {
  // Index stored chunks once by namespace -> key -> chunkIndex, keeping the
  // newest page sequence number for any overwritten chunk index.
  const bestByNsKey = new Map<number, Map<string, Map<number, RawBlobChunk>>>();
  for (let i = 0; i < chunks.length; i += 1) {
    if ((i & 255) === 0) onCheckpoint?.();
    const ch = chunks[i]!;
    let byKey = bestByNsKey.get(ch.nsIndex);
    if (byKey === undefined) {
      byKey = new Map<string, Map<number, RawBlobChunk>>();
      bestByNsKey.set(ch.nsIndex, byKey);
    }
    let byChunkIndex = byKey.get(ch.key);
    if (byChunkIndex === undefined) {
      byChunkIndex = new Map<number, RawBlobChunk>();
      byKey.set(ch.key, byChunkIndex);
    }
    const existing = byChunkIndex.get(ch.chunkIndex);
    if (existing === undefined || ch.pageSeqNo > existing.pageSeqNo) {
      byChunkIndex.set(ch.chunkIndex, ch);
    }
  }

  const sortedByNsKey = new Map<number, Map<string, readonly RawBlobChunk[]>>();
  for (const [nsIndex, byKey] of bestByNsKey) {
    const sortedByKey = new Map<string, readonly RawBlobChunk[]>();
    for (const [key, byChunkIndex] of byKey) {
      sortedByKey.set(
        key,
        [...byChunkIndex.values()].sort((a, b) => a.chunkIndex - b.chunkIndex),
      );
    }
    sortedByNsKey.set(nsIndex, sortedByKey);
  }

  const usedChunkRefs = new Set<RawBlobChunk>();
  const reassemblyCache = new Map<
    number,
    Map<string, Map<number, ReassembledBlobSummary>>
  >();
  const out: Omit<EspNvsEntry, "namespace">[] = [];

  for (let i = 0; i < indices.length; i += 1) {
    if ((i & 255) === 0) onCheckpoint?.();
    const idx = indices[i]!;
    const rangeKey = ((idx.chunkStart & 0xff) << 8) | (idx.chunkCount & 0xff);
    let cacheByKey = reassemblyCache.get(idx.nsIndex);
    if (cacheByKey === undefined) {
      cacheByKey = new Map<string, Map<number, ReassembledBlobSummary>>();
      reassemblyCache.set(idx.nsIndex, cacheByKey);
    }
    let cacheByRange = cacheByKey.get(idx.key);
    if (cacheByRange === undefined) {
      cacheByRange = new Map<number, ReassembledBlobSummary>();
      cacheByKey.set(idx.key, cacheByRange);
    }
    let summary = cacheByRange.get(rangeKey);
    if (summary === undefined) {
      const seriesChunks = sortedByNsKey.get(idx.nsIndex)?.get(idx.key);
      if (seriesChunks === undefined || idx.chunkCount === 0) {
        summary = {
          joinedLength: 0,
          previewHex: "",
          sha256: EMPTY_SHA256,
          allPresent: false,
          chunksCrcValid: true,
        };
      } else {
        const endChunk = idx.chunkStart + idx.chunkCount;
        const preview = Buffer.allocUnsafe(MAX_BLOB_PREVIEW_BYTES);
        // not-an-allowance: bounded 128-byte preview fill cursor
        let previewFilled = 0;
        // not-an-allowance: total reassembled payload byte accumulator
        let joinedLength = 0;
        // not-an-allowance: matched chunk counter in [chunkStart, endChunk)
        let matchedCount = 0;
        let chunksCrcValid = true;
        const hash = createHash("sha256");

        for (const ch of seriesChunks) {
          if (ch.chunkIndex < idx.chunkStart) continue;
          if (ch.chunkIndex >= endChunk) break;
          usedChunkRefs.add(ch);
          matchedCount += 1;
          if (!ch.crcValid) chunksCrcValid = false;
          joinedLength += ch.payload.length;
          hash.update(ch.payload);
          if (previewFilled < MAX_BLOB_PREVIEW_BYTES && ch.payload.length > 0) {
            const copyBytes = Math.min(
              MAX_BLOB_PREVIEW_BYTES - previewFilled,
              ch.payload.length,
            );
            ch.payload.copy(preview, previewFilled, 0, copyBytes);
            previewFilled += copyBytes;
          }
        }

        summary = {
          joinedLength,
          previewHex: preview.subarray(0, previewFilled).toString("hex"),
          sha256: matchedCount === 0 ? EMPTY_SHA256 : hash.digest("hex"),
          allPresent: matchedCount === idx.chunkCount,
          chunksCrcValid,
        };
      }
      cacheByRange.set(rangeKey, summary);
    }

    const allCrcValid = idx.headerCrcValid && summary.chunksCrcValid;
    const complete =
      summary.allPresent && summary.joinedLength === idx.totalSize;
    out.push({
      page_index: idx.pageIndex,
      entry_index: idx.entryIndex,
      file_offset: idx.fileOffset,
      namespace_id: idx.nsIndex,
      key: idx.key,
      data_type: "blob_v2",
      raw_type_code: 0x48,
      span: 1,
      value_text: null,
      value_integer: null,
      blob_size: summary.joinedLength,
      blob_preview_hex: summary.previewHex,
      blob_sha256: summary.sha256,
      crc_valid: allCrcValid,
      completeness: entryCompleteness(allCrcValid, complete),
    });
  }

  for (let i = 0; i < chunks.length; i += 1) {
    if ((i & 255) === 0) onCheckpoint?.();
    const ch = chunks[i]!;
    if (usedChunkRefs.has(ch)) continue;
    out.push({
      page_index: ch.pageIndex,
      entry_index: ch.entryIndex,
      file_offset: ch.fileOffset,
      namespace_id: ch.nsIndex,
      key: ch.key,
      data_type: "blob_data_orphan",
      raw_type_code: 0x42,
      span: ch.span,
      value_text: null,
      value_integer: null,
      blob_size: ch.payload.length,
      blob_preview_hex: ch.payload
        .subarray(0, MAX_BLOB_PREVIEW_BYTES)
        .toString("hex"),
      blob_sha256: sha256Hex(ch.payload),
      crc_valid: ch.crcValid,
      completeness: ch.crcValid ? "missing_chunks" : "crc_mismatch",
    });
  }
  return out;
};
