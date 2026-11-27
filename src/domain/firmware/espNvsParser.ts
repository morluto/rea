import { readUint32At } from "../binaryContainer.js";
import { CoverageAccumulator } from "../coverageAccumulator.js";
import { malformedInput, type ParseFailureError } from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import {
  ESP_NVS_ENTRY_COUNT,
  ESP_NVS_ENTRY_DATA_OFFSET,
  ESP_NVS_ENTRY_TABLE_OFFSET,
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
  type RawBlobChunk,
  type RawBlobIndex,
} from "./espNvsItemDecoder.js";
import { reassembleNvsV2Blobs } from "./espNvsBlobReassembly.js";

const hex32 = (value: number): string => `0x${(value >>> 0).toString(16)}`;

/** ESP-IDF `Page::PageState` values; see `nvs_constants.h`. */
const PAGE_STATES: ReadonlyMap<number, EspNvsPageState> = new Map([
  [0xffff_ffff, "empty"],
  [0xffff_fffe, "active"],
  [0xffff_fffc, "full"],
  [0xffff_fff8, "freeing"],
  [0xffff_fff0, "corrupt"],
  [0x0000_0000, "invalid"],
]);

/** Page states whose entries ESP-IDF reads. */
const READABLE_PAGE_STATES: ReadonlySet<EspNvsPageState> = new Set([
  "active",
  "full",
  "freeing",
]);

const ENTRIES_PER_PAGE = ESP_NVS_ENTRY_COUNT;

const readBitmapSlotState = (
  bitmap32: Uint8Array,
  slotIndex: number,
): "empty" | "written" | "erased" | "illegal" => {
  const byteIdx = slotIndex >>> 2;
  const shift = (slotIndex & 3) * 2;
  const bits = (bitmap32[byteIdx]! >>> shift) & 3;
  if (bits === 3) return "empty";
  if (bits === 2) return "written";
  if (bits === 0) return "erased";
  return "illegal";
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
  // not-an-allowance: tally of pages whose entries were not walked
  undecodedPageCount: number;
}

const undecodedReason = (
  state: EspNvsPageState,
  headerCrcValid: boolean,
): string => {
  if (!headerCrcValid)
    return "its header failed CRC32, which whole-flash encryption or damage produces; NVS encryption leaves page headers in plaintext";
  if (state === "corrupt") return "firmware marked it CORRUPT (0xfffffff0)";
  if (state === "invalid") return "its state is INVALID (0)";
  return "its state is not an ESP-IDF page state";
};

/** Decode the written entries of a page whose header and state ESP-IDF reads. */
const walkPageEntries = (
  page: {
    readonly pageBytes: Buffer;
    readonly bitmap: Uint8Array;
    readonly pageIndex: number;
    readonly seqNo: number;
    readonly pageFileOffset: number;
  },
  acc: PageWalkAccumulator,
): { readonly inconsistentItems: number; readonly consistentItems: number } => {
  const { pageBytes, bitmap, pageIndex, seqNo, pageFileOffset } = page;
  // not-an-allowance: written slots whose header could not be trusted
  let inconsistentItems = 0;
  // not-an-allowance: written slots whose header was trusted
  let consistentItems = 0;
  for (let slotIdx = 0; slotIdx < ENTRIES_PER_PAGE;) {
    if (readBitmapSlotState(bitmap, slotIdx) !== "written") {
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
    if (decoded.inconsistentHeader === true) inconsistentItems += 1;
    else consistentItems += 1;
    if (decoded.inconsistentHeader === true || decoded.damagedItem === true)
      acc.corruptEntryCount += 1;
    acc.anomalies.push(...decoded.anomalies);
    if (decoded.namespaceDef !== undefined) {
      acc.namespacesById.set(decoded.namespaceDef.id, {
        namespace_id: decoded.namespaceDef.id,
        name: decoded.namespaceDef.name,
        page_index: decoded.namespaceDef.pageIndex,
        entry_index: decoded.namespaceDef.entryIndex,
      });
    }
    if (decoded.immediateEntry !== undefined)
      acc.rawEntries.push(decoded.immediateEntry);
    if (decoded.blobIndex !== undefined)
      acc.blobIndices.push(decoded.blobIndex);
    if (decoded.blobChunk !== undefined) acc.blobChunks.push(decoded.blobChunk);
    slotIdx += Math.max(1, decoded.consumedSlots);
  }
  return { inconsistentItems, consistentItems };
};

const decodeSinglePage = (
  pageBytes: Buffer,
  pageIndex: number,
  pageFileOffset: number,
  acc: PageWalkAccumulator,
): void => {
  const rawState = readUint32At(pageBytes, 0, true);
  const bitmap = pageBytes.subarray(
    ESP_NVS_ENTRY_TABLE_OFFSET,
    ESP_NVS_ENTRY_DATA_OFFSET,
  );
  const tallies = { written: 0, erased: 0, empty: 0, illegal: 0 };
  for (let s = 0; s < ENTRIES_PER_PAGE; s += 1)
    tallies[readBitmapSlotState(bitmap, s)] += 1;
  const state = PAGE_STATES.get(rawState) ?? "unknown";

  if (state === "empty") {
    acc.pages.push({
      page_index: pageIndex,
      file_offset: pageFileOffset,
      raw_state: hex32(rawState),
      state,
      seq_no: null,
      format_version: null,
      header_crc_valid: null,
      entries_decoded: false,
      written_slot_count: tallies.written,
      erased_slot_count: tallies.erased,
      empty_slot_count: tallies.empty,
      illegal_slot_count: tallies.illegal,
      inconsistent_item_count: 0,
    });
    if (tallies.empty !== ENTRIES_PER_PAGE)
      acc.anomalies.push(
        `Page ${String(pageIndex)} at offset 0x${pageFileOffset.toString(16)} is uninitialized but its entry-state bitmap marks ${String(ENTRIES_PER_PAGE - tallies.empty)} slot(s) used.`,
      );
    return;
  }

  const seqNo = readUint32At(pageBytes, 4, true);
  const versionByte = pageBytes[8]!;
  const headerCrcValid =
    espIdfCrc32(pageBytes.subarray(4, 28)) ===
    readUint32At(pageBytes, 28, true);
  const formatVersion: EspNvsPageSummary["format_version"] =
    versionByte === 0xfe ? "v2" : versionByte === 0xff ? "v1" : "unknown";
  const entriesDecoded = headerCrcValid && READABLE_PAGE_STATES.has(state);

  if (tallies.illegal > 0)
    acc.anomalies.push(
      `Page ${String(pageIndex)} at offset 0x${pageFileOffset.toString(16)} has ${String(tallies.illegal)} slot(s) in the ILLEGAL entry state (0b01), which only inconsistent flash produces.`,
    );
  if (!entriesDecoded) {
    acc.undecodedPageCount += 1;
    acc.anomalies.push(
      `Page ${String(pageIndex)} at offset 0x${pageFileOffset.toString(16)} (state ${hex32(rawState)}) was not decoded: ${undecodedReason(state, headerCrcValid)}.`,
    );
  }

  const { inconsistentItems, consistentItems } = entriesDecoded
    ? walkPageEntries(
        { pageBytes, bitmap, pageIndex, seqNo, pageFileOffset },
        acc,
      )
    : { inconsistentItems: 0, consistentItems: 0 };
  // NVS encryption (XTS-AES) leaves the page header and entry-state bitmap in
  // plaintext and encrypts each 32-byte entry, so every item header fails.
  if (inconsistentItems > 0 && consistentItems === 0)
    acc.anomalies.push(
      `Page ${String(pageIndex)} at offset 0x${pageFileOffset.toString(16)} has a valid header but none of its ${String(inconsistentItems)} written item header(s) is readable, which is consistent with an encrypted NVS partition.`,
    );

  acc.pages.push({
    page_index: pageIndex,
    file_offset: pageFileOffset,
    raw_state: hex32(rawState),
    state,
    seq_no: headerCrcValid ? seqNo : null,
    format_version: headerCrcValid ? formatVersion : null,
    header_crc_valid: headerCrcValid,
    entries_decoded: entriesDecoded,
    written_slot_count: tallies.written,
    erased_slot_count: tallies.erased,
    empty_slot_count: tallies.empty,
    illegal_slot_count: tallies.illegal,
    inconsistent_item_count: inconsistentItems,
  });
};

/** The type class under which ESP-IDF looks an item up; both blob forms share one. */
const lookupClass = (entry: Omit<EspNvsEntry, "namespace">): string =>
  entry.data_type === "blob_v1" || entry.data_type === "blob_v2"
    ? "blob"
    : String(entry.raw_type_code);

/**
 * Mark every copy of a namespace, key and type older than its newest copy.
 * A rewrite writes the new item before erasing the old one, and a page move
 * copies items before the freeing page is erased, so an interruption leaves
 * both. The newest copy has the higher page sequence number, or the later
 * slot on the same page. Orphan blob chunks are not lookup targets.
 */
const markSuperseded = (
  entries: Omit<EspNvsEntry, "namespace">[],
  seqByPage: ReadonlyMap<number, number>,
): Omit<EspNvsEntry, "namespace">[] => {
  const newest = new Map<string, Omit<EspNvsEntry, "namespace">>();
  const order = (entry: Omit<EspNvsEntry, "namespace">): [number, number] => [
    seqByPage.get(entry.page_index) ?? -1,
    entry.entry_index,
  ];
  const identity = (entry: Omit<EspNvsEntry, "namespace">): string =>
    `${String(entry.namespace_id)}\u0000${entry.key}\u0000${lookupClass(entry)}`;
  for (const entry of entries) {
    if (entry.data_type === "blob_data_orphan") continue;
    const id = identity(entry);
    const current = newest.get(id);
    if (current === undefined) {
      newest.set(id, entry);
      continue;
    }
    const [seq, slot] = order(entry);
    const [currentSeq, currentSlot] = order(current);
    if (seq > currentSeq || (seq === currentSeq && slot > currentSlot))
      newest.set(id, entry);
  }
  return entries.map((entry) =>
    entry.data_type === "blob_data_orphan" ||
    newest.get(identity(entry)) === entry
      ? entry
      : { ...entry, superseded: true },
  );
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
    undecodedPageCount: 0,
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
  const seqByPage = new Map<number, number>();
  for (const page of acc.pages)
    if (page.seq_no !== null) seqByPage.set(page.page_index, page.seq_no);
  const allUnresolved = markSuperseded(
    [...acc.rawEntries, ...v2Blobs],
    seqByPage,
  ).sort((a, b) =>
    a.page_index !== b.page_index
      ? a.page_index - b.page_index
      : a.entry_index - b.entry_index,
  );

  const entries: EspNvsEntry[] = allUnresolved.map((item) => ({
    ...item,
    namespace: acc.namespacesById.get(item.namespace_id)?.name ?? null,
  }));

  const limitations: string[] = [
    "Encrypted NVS partitions (XTS-AES with nvs_keys) are not decrypted. NVS encryption keeps page headers and entry-state bitmaps in plaintext, so an encrypted page decodes as a valid page whose item headers all fail; whole-flash encryption makes the page header fail CRC32 instead.",
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
  if (acc.undecodedPageCount > 0) coverage.recordOmission("undecoded pages");
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
    undecoded_page_count: acc.undecodedPageCount,
    anomalies: acc.anomalies,
    limitations,
  });
};
