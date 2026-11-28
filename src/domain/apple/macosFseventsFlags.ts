/** Supported Disk Log Stream signatures stored in macOS `.fseventsd` files. */
export type MacosFseventsStoreVersion = "1SLD" | "2SLD" | "3SLD";

/** Fixed ceiling on compressed (or raw uncompressed) store file bytes. */
export const FSEVENTS_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Fixed ceiling on decompressed Disk Log Stream bytes across gzip members. */
export const FSEVENTS_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Fixed byte budget across inline sampled record paths (`path` + `raw_path_hex`). */
export const FSEVENTS_MAX_INLINE_PATH_BYTES = 256 * 1024;

/** Maximum DLS block summaries embedded inline in format metadata. */
export const FSEVENTS_INLINE_BLOCK_LIMIT = 32;

/** Maximum event records embedded inline in format metadata. */
export const FSEVENTS_INLINE_EVENT_LIMIT = 32;

/** Maximum structural diagnostics embedded inline in format metadata. */
export const FSEVENTS_INLINE_DIAGNOSTIC_LIMIT = 32;

const RECENT_EVENT_ID_WINDOW = 4096;

/**
 * Darwin `bsd/sys/fsevents.h` disk store event bitmasks (`FLAG = 1 << CONSTANT`)
 * together with item-type and batch markers stored by `fseventsd`.
 */
const FSEVENTS_FLAG_TABLE: readonly (readonly [number, string])[] = [
  [0x0000_0001, "Created"],
  [0x0000_0002, "Removed"],
  [0x0000_0004, "InodeMetaMod"],
  [0x0000_0008, "RenamedOrMoved"],
  [0x0000_0010, "Modified"],
  [0x0000_0020, "Exchange"],
  [0x0000_0040, "FinderInfoMod"],
  [0x0000_0080, "DirectoryCreated"],
  [0x0000_0100, "PermissionChanged"],
  [0x0000_0200, "XAttrModified"],
  [0x0000_0400, "XAttrRemoved"],
  [0x0000_0800, "DocIdCreated"],
  [0x0000_1000, "DocIdChanged"],
  [0x0000_2000, "UnmountPending"],
  [0x0000_4000, "ItemCloned"],
  [0x0001_0000, "ModeClone"],
  [0x0002_0000, "TruncatedPath"],
  [0x0004_0000, "RemoteDirEvent"],
  [0x0008_0000, "LastHardLinkRemoved"],
  [0x0010_0000, "HardLink"],
  [0x0040_0000, "SymbolicLink"],
  [0x0080_0000, "File"],
  [0x0100_0000, "Directory"],
  [0x0200_0000, "Mount"],
  [0x0400_0000, "Unmount"],
  [0x2000_0000, "EndOfTransaction"],
];

const KNOWN_FLAGS_MASK = FSEVENTS_FLAG_TABLE.reduce(
  (mask, [bit]) => (mask | bit) >>> 0,
  0,
);

export const FSEVENTS_FLAG_TRUNCATED_PATH = 0x0002_0000;
export const FSEVENTS_FLAG_MOUNT = 0x0200_0000;
export const FSEVENTS_FLAG_UNMOUNT = 0x0400_0000;
export const FSEVENTS_FLAG_END_OF_TRANSACTION = 0x2000_0000;

export interface MacosFseventsDecodedFlags {
  readonly raw: number;
  readonly raw_hex: string;
  readonly names: readonly string[];
  readonly unknown_mask: number;
}

export interface MacosFseventsBlockSummary {
  readonly index: number;
  readonly stream_offset: number;
  readonly version: MacosFseventsStoreVersion;
  readonly reserved_word: number;
  readonly declared_stream_size: number;
  readonly available_bytes: number;
  readonly record_count: number;
  readonly first_event_id: string | null;
  readonly last_event_id: string | null;
  readonly trailing_unparsed_bytes: number;
  readonly truncated: boolean;
}

export interface MacosFseventsDiagnostic {
  readonly stream_offset: number;
  readonly reason: string;
  readonly detail: string;
}

export interface MacosFseventsRecordSample {
  readonly block_index: number;
  readonly stream_offset: number;
  readonly version: MacosFseventsStoreVersion;
  readonly event_id: string;
  readonly flags: MacosFseventsDecodedFlags;
  readonly path: string;
  readonly path_encoding: "utf-8" | "invalid-utf8";
  readonly raw_path_hex: string;
  readonly node_id: string | null;
  readonly extra_word: number | null;
  readonly out_of_order: boolean;
  readonly duplicate_event_id: boolean;
  readonly event_id_gap_from_previous: string | null;
}

export interface MacosFseventsMetadata {
  readonly kind: "macos-fsevents";
  readonly compression: "gzip" | "none";
  readonly compressed_bytes: number;
  readonly decompressed_bytes: number;
  readonly store_versions: readonly MacosFseventsStoreVersion[];
  readonly block_count: number;
  readonly blocks: readonly MacosFseventsBlockSummary[];
  readonly omitted_blocks: number;
  readonly record_count: number;
  readonly first_event_id: string | null;
  readonly last_event_id: string | null;
  readonly out_of_order_record_count: number;
  readonly duplicate_event_id_count: number;
  readonly event_id_gap_count: number;
  readonly mount_event_count: number;
  readonly unmount_event_count: number;
  readonly end_of_transaction_count: number;
  readonly truncated_path_flag_count: number;
  readonly non_utf8_path_count: number;
  readonly malformed_record_count: number;
  readonly trailing_zero_bytes: number;
  readonly flag_counts: readonly {
    readonly name: string;
    readonly count: number;
  }[];
  readonly diagnostics: readonly MacosFseventsDiagnostic[];
  readonly omitted_diagnostics: number;
  readonly records: readonly MacosFseventsRecordSample[];
  readonly omitted_records: number;
}

export interface MacosFseventsInventory {
  readonly metadata: MacosFseventsMetadata;
  readonly limitations: readonly string[];
}

/** Decode documented Darwin disk store flag bits while preserving raw and unknown bits. */
export const decodeFseventsFlags = (
  rawFlags: number,
): MacosFseventsDecodedFlags => {
  const raw = rawFlags >>> 0;
  const names: string[] = [];
  for (const [bit, label] of FSEVENTS_FLAG_TABLE) {
    if ((raw & bit) !== 0) names.push(label);
  }
  return {
    raw,
    raw_hex: `0x${raw.toString(16).padStart(8, "0")}`,
    names,
    unknown_mask: (raw & ~KNOWN_FLAGS_MASK) >>> 0,
  };
};

/** Bounded rolling tracker identifying adjacent or recently seen event IDs. */
export class RecentEventIdTracker {
  readonly #ring: (bigint | undefined)[] = Array.from(
    { length: RECENT_EVENT_ID_WINDOW },
    () => undefined,
  );
  readonly #counts = new Map<bigint, number>();
  #cursor = 0;

  seenOrRecord(id: bigint): boolean {
    const duplicate = (this.#counts.get(id) ?? 0) > 0;
    const evicted = this.#ring[this.#cursor];
    if (evicted !== undefined) {
      const remaining = (this.#counts.get(evicted) ?? 1) - 1;
      if (remaining <= 0) this.#counts.delete(evicted);
      else this.#counts.set(evicted, remaining);
    }
    this.#ring[this.#cursor] = id;
    this.#counts.set(id, (this.#counts.get(id) ?? 0) + 1);
    this.#cursor = (this.#cursor + 1) % RECENT_EVENT_ID_WINDOW;
    return duplicate;
  }
}
