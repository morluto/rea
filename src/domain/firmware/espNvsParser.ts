import { setImmediate } from "node:timers/promises";
import { byteToHex } from "../../kernel/byteToHex.js";
import { BinaryReader, readUint32At } from "../binaryContainer.js";
import { Budget } from "../budget.js";
import { CoverageAccumulator } from "../coverageAccumulator.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import {
  DEFAULT_ESP_NVS_MAX_DECODED_BYTES,
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
  readBitmapSlotState,
  type PendingNvsEntry,
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

/** Initialized ESP-IDF page states whose 32-byte header carries version and CRC32. */
const INITIALIZED_PAGE_STATES: ReadonlySet<EspNvsPageState> = new Set([
  "active",
  "full",
  "freeing",
  "corrupt",
]);

const ENTRIES_PER_PAGE = ESP_NVS_ENTRY_COUNT;
const PAGES_PER_YIELD = 16;

/**
 * Whether `prefix` begins a standalone 4096-byte-multiple ESP-IDF v1/v2 NVS
 * partition: an initialized page state, v1/v2 format byte (`0xff`/`0xfe`),
 * ESP-IDF's 19 `0xff` reserved header bytes, and a matching header CRC32.
 */
export const hasEspNvsHeader = (
  prefix: Uint8Array,
  fileSize: number,
): boolean => {
  if (
    fileSize < ESP_NVS_PAGE_BYTES ||
    fileSize % ESP_NVS_PAGE_BYTES !== 0 ||
    prefix.length < ESP_NVS_ENTRY_TABLE_OFFSET
  ) {
    return false;
  }
  const state = PAGE_STATES.get(readUint32At(prefix, 0, true));
  if (state === undefined || !INITIALIZED_PAGE_STATES.has(state)) return false;
  const versionByte = prefix[8]!;
  if (versionByte !== 0xfe && versionByte !== 0xff) return false;
  for (let i = 9; i < 28; i += 1) {
    if (prefix[i] !== 0xff) return false;
  }
  return espIdfCrc32(prefix.subarray(4, 28)) === readUint32At(prefix, 28, true);
};

interface PageWalkAccumulator {
  readonly pages: EspNvsPageSummary[];
  readonly seqByPage: Map<number, number>;
  readonly namespacesById: Map<number, EspNvsNamespace>;
  readonly rawEntries: PendingNvsEntry[];
  readonly blobIndices: RawBlobIndex[];
  readonly blobChunks: RawBlobChunk[];
  readonly anomalies: string[];
  readonly admitDecodedBytes: (bytes: number) => void;
  // not-an-allowance: corrupt entry tally
  corruptEntryCount: number;
  // not-an-allowance: tally of pages whose entries were not walked
  undecodedPageCount: number;
  hasIllegalSlots: boolean;
  hasDirtyEmptyPage: boolean;
}

const recordAnomaly = (acc: PageWalkAccumulator, message: string): void => {
  acc.admitDecodedBytes(64 + message.length * 2);
  acc.anomalies.push(message);
};

const entryDecodedBytes = (entry: PendingNvsEntry): number =>
  512 +
  entry.key.length * 2 +
  (entry.value_text?.length ?? 0) * 2 +
  (entry.blob_preview_hex?.length ?? 0) * 2;

const undecodedReason = (
  state: EspNvsPageState,
  headerCrcValid: boolean,
  versionByte: number,
): string => {
  if (!headerCrcValid)
    return "its header failed CRC32, which whole-flash encryption or damage produces; NVS encryption leaves page headers in plaintext";
  if (READABLE_PAGE_STATES.has(state))
    return `its format version byte 0x${byteToHex(versionByte)} is not ESP-IDF v1 (0xff) or v2 (0xfe)`;
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
  const pageReader = new BinaryReader(pageBytes, true, "esp-nvs");
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
      pageReader,
      bitmap,
      pageIndex,
      pageSeqNo: seqNo,
      pageFileOffset,
      entryIndex: slotIdx,
    });
    if (decoded.inconsistentHeader === true) inconsistentItems += 1;
    else consistentItems += 1;
    if (decoded.inconsistentHeader === true || decoded.damagedItem === true)
      acc.corruptEntryCount += 1;
    for (const anomaly of decoded.anomalies) recordAnomaly(acc, anomaly);
    if (decoded.namespaceDef !== undefined) {
      if (!acc.namespacesById.has(decoded.namespaceDef.id)) {
        acc.admitDecodedBytes(128 + decoded.namespaceDef.name.length * 2);
      }
      acc.namespacesById.set(decoded.namespaceDef.id, {
        namespace_id: decoded.namespaceDef.id,
        name: decoded.namespaceDef.name,
        page_index: decoded.namespaceDef.pageIndex,
        entry_index: decoded.namespaceDef.entryIndex,
      });
    }
    if (decoded.immediateEntry !== undefined) {
      acc.admitDecodedBytes(entryDecodedBytes(decoded.immediateEntry));
      acc.rawEntries.push(decoded.immediateEntry);
    }
    if (decoded.blobIndex !== undefined) {
      acc.admitDecodedBytes(256 + decoded.blobIndex.key.length * 2);
      acc.blobIndices.push(decoded.blobIndex);
    }
    if (decoded.blobChunk !== undefined) {
      acc.admitDecodedBytes(
        256 +
          decoded.blobChunk.key.length * 2 +
          decoded.blobChunk.payload.length,
      );
      acc.blobChunks.push(decoded.blobChunk);
    }
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
  if (tallies.illegal > 0) acc.hasIllegalSlots = true;
  const state = PAGE_STATES.get(rawState) ?? "unknown";

  if (state === "empty") {
    acc.admitDecodedBytes(256);
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
    if (tallies.empty !== ENTRIES_PER_PAGE) {
      acc.hasDirtyEmptyPage = true;
      recordAnomaly(
        acc,
        `Page ${String(pageIndex)} at offset 0x${pageFileOffset.toString(16)} is uninitialized but its entry-state bitmap marks ${String(ENTRIES_PER_PAGE - tallies.empty)} slot(s) used.`,
      );
    }
    return;
  }

  const seqNo = readUint32At(pageBytes, 4, true);
  const versionByte = pageBytes[8]!;
  const headerCrcValid =
    espIdfCrc32(pageBytes.subarray(4, 28)) ===
    readUint32At(pageBytes, 28, true);
  const formatVersion: EspNvsPageSummary["format_version"] =
    versionByte === 0xfe ? "v2" : versionByte === 0xff ? "v1" : "unknown";
  const entriesDecoded =
    headerCrcValid &&
    READABLE_PAGE_STATES.has(state) &&
    formatVersion !== "unknown";

  if (tallies.illegal > 0)
    recordAnomaly(
      acc,
      `Page ${String(pageIndex)} at offset 0x${pageFileOffset.toString(16)} has ${String(tallies.illegal)} slot(s) in the ILLEGAL entry state (0b01), which only inconsistent flash produces.`,
    );
  if (!entriesDecoded) {
    acc.undecodedPageCount += 1;
    recordAnomaly(
      acc,
      `Page ${String(pageIndex)} at offset 0x${pageFileOffset.toString(16)} (state ${hex32(rawState)}) was not decoded: ${undecodedReason(state, headerCrcValid, versionByte)}.`,
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
    recordAnomaly(
      acc,
      `Page ${String(pageIndex)} at offset 0x${pageFileOffset.toString(16)} has a valid header but none of its ${String(inconsistentItems)} written item header(s) is readable, which is consistent with an encrypted NVS partition.`,
    );

  if (headerCrcValid) acc.seqByPage.set(pageIndex, seqNo);
  acc.admitDecodedBytes(256);
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
const lookupClass = (entry: PendingNvsEntry): string =>
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
  entries: PendingNvsEntry[],
  seqByPage: ReadonlyMap<number, number>,
): PendingNvsEntry[] => {
  const newest = new Map<string, PendingNvsEntry>();
  const order = (entry: PendingNvsEntry): [number, number] => [
    seqByPage.get(entry.page_index) ?? -1,
    entry.entry_index,
  ];
  const identity = (entry: PendingNvsEntry): string =>
    `${String(entry.namespace_id)}\u0000${entry.keyId}\u0000${lookupClass(entry)}`;
  for (const entry of entries) {
    if (
      entry.data_type === "blob_data_orphan" ||
      entry.data_type === "blob_data_copy" ||
      entry.completeness !== "complete"
    )
      continue;
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
  return entries.map((entry) => {
    if (
      entry.data_type === "blob_data_orphan" ||
      entry.data_type === "blob_data_copy"
    )
      return entry;
    const winner = newest.get(identity(entry));
    if (winner === undefined || winner === entry) return entry;
    const [seq, slot] = order(entry);
    const [winnerSeq, winnerSlot] = order(winner);
    return winnerSeq > seq || (winnerSeq === seq && winnerSlot > slot)
      ? { ...entry, superseded: true }
      : entry;
  });
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
  readonly maxDecodedBytes?: number | undefined;
  readonly onCheckpoint?: (() => void) | undefined;
}

/** Decode a complete ESP-IDF v1/v2 Non-Volatile Storage partition slice. */
export const parseEspNvsPartition = async (
  options: ParseEspNvsOptions,
): Promise<
  Result<
    EspNvsReport,
    ParseFailureError<"malformed"> | ParseFailureError<"limit">
  >
> => {
  const {
    artifact,
    partitionOffset,
    partitionBytes,
    sliceBytes,
    maxDecodedBytes = DEFAULT_ESP_NVS_MAX_DECODED_BYTES,
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
  const decodedBudget = new Budget(maxDecodedBytes);
  const admitDecodedBytes = (bytes: number): void => {
    decodedBudget.charge(bytes, () =>
      decodeLimit(
        "esp-nvs",
        `Decoded ESP-IDF NVS representation exceeds max_decoded_bytes (${String(maxDecodedBytes)} bytes).`,
        { name: "max_decoded_bytes", maximum: maxDecodedBytes },
      ),
    );
  };

  try {
    const acc: PageWalkAccumulator = {
      pages: [],
      seqByPage: new Map(),
      namespacesById: new Map(),
      rawEntries: [],
      blobIndices: [],
      blobChunks: [],
      anomalies: [],
      admitDecodedBytes,
      corruptEntryCount: 0,
      undecodedPageCount: 0,
      hasIllegalSlots: false,
      hasDirtyEmptyPage: false,
    };

    for (let p = 0; p < pageCount; p += 1) {
      if (p > 0 && p % PAGES_PER_YIELD === 0) await setImmediate();
      onCheckpoint?.();
      const start = p * ESP_NVS_PAGE_BYTES;
      decodeSinglePage(
        sliceBytes.subarray(start, start + ESP_NVS_PAGE_BYTES),
        p,
        partitionOffset + start,
        acc,
      );
    }

    const v2Blobs = await reassembleNvsV2Blobs(
      acc.blobIndices,
      acc.blobChunks,
      onCheckpoint,
      admitDecodedBytes,
    );
    const totalPending = acc.rawEntries.length + v2Blobs.length;
    admitDecodedBytes(totalPending * 256);
    const allUnresolved = markSuperseded(
      [...acc.rawEntries, ...v2Blobs],
      acc.seqByPage,
    ).sort((a, b) =>
      a.page_index !== b.page_index
        ? a.page_index - b.page_index
        : a.entry_index - b.entry_index,
    );

    let hasMissingChunks = false;
    let hasCrcMismatch = false;
    let hasUnresolvedNamespace = false;
    const entries: EspNvsEntry[] = [];
    for (const { keyId: _keyId, ...item } of allUnresolved) {
      const namespace = acc.namespacesById.get(item.namespace_id)?.name ?? null;
      if (item.completeness === "missing_chunks") hasMissingChunks = true;
      else if (item.completeness === "crc_mismatch") hasCrcMismatch = true;
      if (namespace === null) hasUnresolvedNamespace = true;
      entries.push({ ...item, namespace });
    }

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
    if (acc.corruptEntryCount > 0)
      coverage.recordOmission("corrupt NVS entries");
    if (acc.hasIllegalSlots)
      coverage.recordOmission("illegal NVS bitmap slots");
    if (acc.hasDirtyEmptyPage)
      coverage.recordOmission(
        "uninitialized pages with non-empty slot bitmaps",
      );
    if (hasMissingChunks) coverage.recordOmission("missing NVS blob chunks");
    if (hasCrcMismatch) coverage.recordOmission("NVS entry CRC mismatch");
    if (hasUnresolvedNamespace)
      coverage.recordOmission("unresolved NVS namespace definitions");

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
  } catch (cause) {
    if (isEspNvsLimit(cause)) return err(cause);
    throw cause;
  }
};

const isEspNvsLimit = (cause: unknown): cause is ParseFailureError<"limit"> =>
  cause instanceof ParseFailureError && cause.failure.kind === "limit";
