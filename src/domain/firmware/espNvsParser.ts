import { readUint32At } from "../binaryContainer.js";
import { CoverageAccumulator } from "../coverageAccumulator.js";
import { malformedInput, type ParseFailureError } from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import {
  ESP_NVS_PAGE_BYTES,
  type EspNvsEntry,
  type EspNvsNamespace,
  type EspNvsPageState,
  type EspNvsPageSummary,
  type EspNvsReport,
} from "./espNvs.js";
import {
  decodeWrittenNvsSlot,
  espIdfCrc32,
  reassembleNvsV2Blobs,
  type RawBlobChunk,
  type RawBlobIndex,
} from "./espNvsItemDecoder.js";

const hex32 = (value: number): string => `0x${(value >>> 0).toString(16)}`;

const classifyPageState = (
  rawState: number,
  headerCrcValid: boolean,
): EspNvsPageState => {
  if (rawState === 0xffff_ffff) return "empty";
  if (!headerCrcValid) return "corrupt_or_encrypted";
  switch (rawState) {
    case 0xffff_fffe:
      return "active";
    case 0xffff_fffc:
      return "full";
    case 0xffff_fff8:
      return "freeing";
    default:
      return "corrupt_or_encrypted";
  }
};

const readBitmapSlotState = (
  bitmap32: Uint8Array,
  slotIndex: number,
): "empty" | "written" | "erased" | "reserved" => {
  const byteIdx = slotIndex >>> 2;
  const shift = (slotIndex & 3) * 2;
  const bits = (bitmap32[byteIdx]! >>> shift) & 3;
  if (bits === 3) return "empty";
  if (bits === 2) return "written";
  if (bits === 0) return "erased";
  return "reserved";
};

interface PageWalkAccumulator {
  readonly pages: EspNvsPageSummary[];
  readonly namespacesById: Map<number, EspNvsNamespace>;
  readonly rawEntries: Omit<EspNvsEntry, "namespace">[];
  readonly blobIndices: RawBlobIndex[];
  readonly blobChunks: RawBlobChunk[];
  readonly anomalies: string[];
  // not-an-allowance: corrupt entry tally
  corruptEntryCount: number;
  // not-an-allowance: corrupt or encrypted page tally
  corruptPageCount: number;
}

const decodeSinglePage = (
  pageBytes: Buffer,
  pageIndex: number,
  pageFileOffset: number,
  acc: PageWalkAccumulator,
): void => {
  const rawState = readUint32At(pageBytes, 0, true);
  if (rawState === 0xffff_ffff) {
    acc.pages.push({
      page_index: pageIndex,
      file_offset: pageFileOffset,
      raw_state: hex32(rawState),
      state: "empty",
      seq_no: null,
      format_version: null,
      header_crc_valid: null,
      written_slot_count: 0,
      erased_slot_count: 0,
      empty_slot_count: 126,
    });
    return;
  }

  const seqNo = readUint32At(pageBytes, 4, true);
  const versionByte = pageBytes[8]!;
  const declaredHeaderCrc = readUint32At(pageBytes, 28, true);
  const computedHeaderCrc = espIdfCrc32(pageBytes.subarray(4, 28));
  const headerCrcValid = computedHeaderCrc === declaredHeaderCrc;
  const state = classifyPageState(rawState, headerCrcValid);
  const formatVersion: EspNvsPageSummary["format_version"] =
    versionByte === 0xfe ? "v2" : versionByte === 0xff ? "v1" : "unknown";

  const bitmap = pageBytes.subarray(32, 64);
  // not-an-allowance: bitmap slot state tallies
  let writtenSlots = 0;
  // not-an-allowance: bitmap slot state tallies
  let erasedSlots = 0;
  // not-an-allowance: bitmap slot state tallies
  let emptySlots = 0;
  for (let s = 0; s < 126; s += 1) {
    const st = readBitmapSlotState(bitmap, s);
    if (st === "written") writtenSlots += 1;
    else if (st === "erased") erasedSlots += 1;
    else if (st === "empty") emptySlots += 1;
  }

  acc.pages.push({
    page_index: pageIndex,
    file_offset: pageFileOffset,
    raw_state: hex32(rawState),
    state,
    seq_no: headerCrcValid ? seqNo : null,
    format_version: headerCrcValid ? formatVersion : null,
    header_crc_valid: headerCrcValid,
    written_slot_count: writtenSlots,
    erased_slot_count: erasedSlots,
    empty_slot_count: emptySlots,
  });

  if (state === "corrupt_or_encrypted") {
    acc.corruptPageCount += 1;
    acc.anomalies.push(
      `Page ${String(pageIndex)} at offset 0x${pageFileOffset.toString(16)} failed header CRC32 or carries non-NVS state ${hex32(rawState)} (corrupt or XTS-AES encrypted NVS).`,
    );
    return;
  }

  // Walk active/full/freeing written entries in slot order.
  for (let slotIdx = 0; slotIdx < 126;) {
    const st = readBitmapSlotState(bitmap, slotIdx);
    if (st !== "written") {
      slotIdx += 1;
      continue;
    }
    const decoded = decodeWrittenNvsSlot({
      pageBytes,
      pageIndex,
      pageSeqNo: seqNo,
      pageFileOffset,
      entryIndex: slotIdx,
    });
    if (decoded.crcMismatch === true) acc.corruptEntryCount += 1;
    if (decoded.anomaly !== undefined) acc.anomalies.push(decoded.anomaly);
    if (decoded.namespaceDef !== undefined) {
      acc.namespacesById.set(decoded.namespaceDef.id, {
        namespace_id: decoded.namespaceDef.id,
        name: decoded.namespaceDef.name,
        page_index: decoded.namespaceDef.pageIndex,
        entry_index: decoded.namespaceDef.entryIndex,
      });
    }
    if (decoded.immediateEntry !== undefined) {
      acc.rawEntries.push(decoded.immediateEntry);
    }
    if (decoded.blobIndex !== undefined)
      acc.blobIndices.push(decoded.blobIndex);
    if (decoded.blobChunk !== undefined) acc.blobChunks.push(decoded.blobChunk);
    slotIdx += Math.max(1, decoded.consumedSlots);
  }
};

export interface ParseEspNvsOptions {
  readonly artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly partitionOffset: number;
  readonly partitionBytes?: number | undefined;
  readonly sliceBytes: Buffer;
  readonly onCheckpoint?: (() => void) | undefined;
}

/** Decode a complete ESP-IDF v1/v2 Non-Volatile Storage partition slice. */
export const parseEspNvsPartition = (
  options: ParseEspNvsOptions,
): Result<EspNvsReport, ParseFailureError<"malformed">> => {
  const {
    artifact,
    partitionOffset,
    partitionBytes,
    sliceBytes,
    onCheckpoint,
  } = options;
  if (
    partitionOffset >= artifact.bytes ||
    sliceBytes.length < ESP_NVS_PAGE_BYTES
  ) {
    return err(
      malformedInput(
        "esp-nvs",
        `partition_offset ${String(partitionOffset)} leaves fewer than ${String(ESP_NVS_PAGE_BYTES)} bytes (one NVS page) in the ${String(artifact.bytes)}-byte file.`,
      ),
    );
  }
  if (
    partitionBytes !== undefined &&
    (sliceBytes.length < partitionBytes ||
      partitionOffset + partitionBytes > artifact.bytes)
  ) {
    return err(
      malformedInput(
        "esp-nvs",
        `Requested partition_bytes (${String(partitionBytes)}) at partition_offset ${String(partitionOffset)} exceeds the ${String(artifact.bytes)}-byte file.`,
      ),
    );
  }

  const pageCount = Math.floor(sliceBytes.length / ESP_NVS_PAGE_BYTES);
  const trailingBytes = sliceBytes.length - pageCount * ESP_NVS_PAGE_BYTES;
  const acc: PageWalkAccumulator = {
    pages: [],
    namespacesById: new Map(),
    rawEntries: [],
    blobIndices: [],
    blobChunks: [],
    anomalies: [],
    corruptEntryCount: 0,
    corruptPageCount: 0,
  };

  for (let p = 0; p < pageCount; p += 1) {
    onCheckpoint?.();
    const start = p * ESP_NVS_PAGE_BYTES;
    decodeSinglePage(
      sliceBytes.subarray(start, start + ESP_NVS_PAGE_BYTES),
      p,
      partitionOffset + start,
      acc,
    );
  }

  const v2Blobs = reassembleNvsV2Blobs(
    acc.blobIndices,
    acc.blobChunks,
    onCheckpoint,
  );
  const allUnresolved = [...acc.rawEntries, ...v2Blobs].sort((a, b) =>
    a.page_index !== b.page_index
      ? a.page_index - b.page_index
      : a.entry_index - b.entry_index,
  );

  const entries: EspNvsEntry[] = allUnresolved.map((item) => ({
    ...item,
    namespace: acc.namespacesById.get(item.namespace_id)?.name ?? null,
  }));

  const limitations: string[] = [
    "Encrypted NVS partitions (XTS-AES with nvs_keys) are not decrypted; encrypted pages fail header CRC32 and are reported as corrupt_or_encrypted.",
  ];
  if (trailingBytes > 0) {
    limitations.push(
      `${String(trailingBytes)} trailing byte(s) after the last complete 4096-byte NVS page were not decoded.`,
    );
  }

  const namespaces = [...acc.namespacesById.values()].sort(
    (a, b) => a.namespace_id - b.namespace_id,
  );
  const coverage = new CoverageAccumulator().recordComplete();
  if (trailingBytes > 0) coverage.recordOmission("trailing unaligned bytes");
  if (acc.corruptPageCount > 0)
    coverage.recordOmission("corrupt or encrypted pages");
  if (acc.corruptEntryCount > 0) coverage.recordOmission("corrupt NVS entries");

  return ok({
    artifact,
    partition_range: {
      start: partitionOffset,
      end: partitionOffset + pageCount * ESP_NVS_PAGE_BYTES,
      page_count: pageCount,
      trailing_unaligned_bytes: trailingBytes,
    },
    coverage: {
      status: coverage.finalizeKnown(),
      examined_pages: pageCount,
      retained_entries: entries.length,
      omitted_entries: 0,
    },
    pages: acc.pages,
    namespaces,
    entries,
    corrupt_entry_count: acc.corruptEntryCount,
    corrupt_or_encrypted_page_count: acc.corruptPageCount,
    anomalies: acc.anomalies,
    limitations,
  });
};
