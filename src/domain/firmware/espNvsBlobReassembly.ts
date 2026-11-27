import { createHash } from "node:crypto";
import type { EspNvsEntry } from "./espNvs.js";
import {
  EMPTY_SHA256,
  ITEM_TYPE,
  MAX_BLOB_PREVIEW_BYTES,
  blobValues,
  emptyValues,
  entryCompleteness,
  type RawBlobChunk,
  type RawBlobIndex,
} from "./espNvsItemDecoder.js";

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
      raw_type_code: ITEM_TYPE.BLOB_IDX,
      span: 1,
      value_text: null,
      value_integer: null,
      value_float: null,
      blob_size: summary.joinedLength,
      blob_preview_hex: summary.previewHex,
      blob_sha256: summary.sha256,
      crc_valid: allCrcValid,
      completeness: entryCompleteness(allCrcValid, complete),
      superseded: false,
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
      raw_type_code: ITEM_TYPE.BLOB_DATA,
      span: ch.span,
      ...emptyValues,
      ...blobValues(ch.payload),
      crc_valid: ch.crcValid,
      completeness: ch.crcValid ? "missing_chunks" : "crc_mismatch",
      superseded: false,
    });
  }
  return out;
};
