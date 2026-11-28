import { BinaryReader } from "../binaryContainer.js";
import { ok, err, type Result } from "../result.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/** Every systemd journal file begins with this signature. */
const JOURNAL_SIGNATURE = "LPKSHHRH";
const JOURNAL_SIGNATURE_BYTES = 8;
/** The current header struct; later format revisions only append fields. */
const JOURNAL_HEADER_BYTES = 272;
/**
 * `ALIGN64(offsetof(Header, n_data))`: the oldest header systemd still accepts.
 * Everything before `n_data` is required; `n_data` and later fields are optional.
 */
const JOURNAL_HEADER_MIN_BYTES = 208;
/** `header_size` sits at offset 88; this prefix is what recognizing a header needs. */
const JOURNAL_HEADER_SIZE_PROBE_BYTES = 96;
/** Objects start at the header's end and are 8-byte aligned. */
const JOURNAL_OBJECT_ALIGNMENT = 8;
const JOURNAL_OBJECT_HEADER_BYTES = 16;
/**
 * Object headers retained per window. The whole chain is still walked and
 * counted; a caller selects later windows with `objectHeaderStart`.
 */
export const JOURNAL_INLINE_OBJECT_LIMIT = 32;

/** Header flag bits that change how the object area must be read. */
const INCOMPATIBLE_FLAGS = new Map<number, string>([
  [1 << 0, "compressed-xz"],
  [1 << 1, "compressed-lz4"],
  [1 << 2, "keyed-hash"],
  [1 << 3, "compressed-zstd"],
  [1 << 4, "compact"],
]);
/** Bits this reader accounts for; any other set bit changes the on-disk layout. */
const INCOMPATIBLE_FLAGS_KNOWN = [...INCOMPATIBLE_FLAGS.keys()].reduce(
  (known, bit) => known | bit,
  0,
);
/** `HEADER_COMPATIBLE_TAIL_ENTRY_BOOT_ID` in systemd's `journal-def.h`. */
const COMPATIBLE_TAIL_ENTRY_BOOT_ID = 1 << 1;
const COMPATIBLE_FLAGS = new Map<number, string>([
  [1 << 0, "sealed"],
  [COMPATIBLE_TAIL_ENTRY_BOOT_ID, "tail-entry-boot-id"],
  [1 << 2, "sealed-continuous"],
]);
/** Object flags share their bit values with the compression algorithms. */
const OBJECT_FLAG_NAMES = new Map<number, string>([
  [1 << 0, "compressed-xz"],
  [1 << 1, "compressed-lz4"],
  [1 << 2, "compressed-zstd"],
]);
const OBJECT_TYPE_MASK = 0xff;
const OBJECT_COMPRESSED_MASK = 0x07;

const OBJECT_TYPES = new Map<number, string>([
  [0, "unused"],
  [1, "data"],
  [2, "field"],
  [3, "entry"],
  [4, "data-hash-table"],
  [5, "field-hash-table"],
  [6, "entry-array"],
  [7, "tag"],
]);

const JOURNAL_STATES = new Map<number, string>([
  [0, "offline"],
  [1, "online"],
  [2, "archived"],
]);

/** Header field offsets, relative to the signature. */
const HEADER = {
  compatibleFlags: 8,
  incompatibleFlags: 12,
  state: 16,
  fileId: 24,
  machineId: 40,
  tailEntryBootId: 56,
  seqnumId: 72,
  headerSize: 88,
  arenaSize: 96,
  dataHashTableOffset: 104,
  dataHashTableSize: 112,
  fieldHashTableOffset: 120,
  fieldHashTableSize: 128,
  tailObjectOffset: 136,
  nObjects: 144,
  nEntries: 152,
  tailEntrySeqnum: 160,
  headEntrySeqnum: 168,
  entryArrayOffset: 176,
  headEntryRealtime: 184,
  tailEntryRealtime: 192,
  tailEntryMonotonic: 200,
  nData: 208,
  nFields: 216,
  nTags: 224,
  nEntryArrays: 232,
  dataHashChainDepth: 240,
  fieldHashChainDepth: 248,
  tailEntryArrayOffset: 256,
  tailEntryArrayNEntries: 260,
  tailEntryOffset: 264,
} as const;

/** Numeric header declarations left unread when the header cannot be anchored. */
const UNREAD_HEADER_FIELDS: readonly string[] = [
  "arena_size",
  "data_hash_table_offset",
  "data_hash_table_size",
  "field_hash_table_offset",
  "field_hash_table_size",
  "tail_object_offset",
  "n_objects",
  "n_entries",
  "tail_entry_seqnum",
  "head_entry_seqnum",
  "entry_array_offset",
  "head_entry_realtime",
  "tail_entry_realtime",
  "tail_entry_monotonic",
];

export interface JournalHeaderFacts {
  readonly compatible_flags: number;
  readonly compatible_flag_names: readonly string[];
  readonly incompatible_flags: number;
  readonly incompatible_flag_names: readonly string[];
  readonly state: string;
  readonly file_id: string;
  readonly machine_id: string;
  /** Null when the compatible `tail-entry-boot-id` flag is clear. */
  readonly tail_entry_boot_id: string | null;
  /** The legacy boot id at bytes 56-71; null when the flag makes it a tail id. */
  readonly boot_id: string | null;
  readonly seqnum_id: string;
  readonly header_size: number;
  readonly arena_size: number;
  readonly data_hash_table_offset: number;
  readonly data_hash_table_size: number;
  readonly field_hash_table_offset: number;
  readonly field_hash_table_size: number;
  readonly tail_object_offset: number;
  readonly n_objects: number;
  readonly n_entries: number;
  readonly tail_entry_seqnum: number;
  readonly head_entry_seqnum: number;
  readonly entry_array_offset: number;
  readonly head_entry_realtime: number;
  readonly tail_entry_realtime: number;
  readonly tail_entry_monotonic: number;
  /** Null when the declared header predates the field's introduction. */
  readonly n_data: number | null;
  readonly n_fields: number | null;
  readonly n_tags: number | null;
  readonly n_entry_arrays: number | null;
  readonly data_hash_chain_depth: number | null;
  readonly field_hash_chain_depth: number | null;
  readonly tail_entry_array_offset: number | null;
  readonly tail_entry_array_n_entries: number | null;
  readonly tail_entry_offset: number | null;
  /**
   * Fields that declared a value above `Number.MAX_SAFE_INTEGER`. Their
   * reported value is that ceiling, so these names say which ones are not exact.
   */
  readonly overflowed_fields: readonly string[];
  /**
   * Fields the reader never read, reported as zero. Non-empty only for a header
   * whose declared size could not anchor the object area; a reader must treat
   * these as unknown rather than observed.
   */
  readonly unread_fields: readonly string[];
}

export interface JournalObjectHeader {
  /** File offset where the object's 16-byte header starts. */
  readonly offset: number;
  readonly type: string;
  readonly raw_type: number;
  readonly flags: number;
  readonly flag_names: readonly string[];
  readonly size: number;
  /** True when the declared size exceeds Number.MAX_SAFE_INTEGER. */
  readonly size_overflowed: boolean;
  readonly compressed: boolean;
}

export interface JournalObjectTypeCount {
  readonly type: string;
  readonly count: number;
}

export interface JournalInventory {
  readonly metadata: JournalMetadata;
  readonly limitations: readonly string[];
}

export interface JournalMetadata {
  readonly kind: "systemd-journal";
  readonly header: JournalHeaderFacts;
  readonly object_count: number;
  /** Objects whose declared extent lies wholly inside the file. */
  readonly valid_object_count: number;
  /** Objects cut short by the file's end. */
  readonly truncated_object_count: number;
  /** Objects whose declared type is outside the known range. */
  readonly unknown_type_object_count: number;
  readonly object_type_counts: readonly JournalObjectTypeCount[];
  readonly object_headers: readonly JournalObjectHeader[];
  /**
   * Walked objects outside `object_headers`. Later headers are paged through
   * inspect_analysis_view's `format_record_headers` collection, which re-reads
   * the file from a selected index.
   */
  readonly omitted_object_headers: number;
  /**
   * Bytes after the last walked object. When the header declares a tail object,
   * this is the journal's preallocated arena capacity, not corruption.
   */
  readonly trailing_bytes: number;
}

const failure = (
  message: string,
  boundary?: RegionDecodeFailure["boundary"],
): RegionDecodeFailure => ({
  kind: "malformed",
  message,
  ...(boundary === undefined ? {} : { boundary }),
});

const unsupported = (message: string): RegionDecodeFailure => ({
  kind: "unsupported",
  message,
});

/** A 16-byte hexadecimal spelling of a 128-bit id; zeros stay distinguishable from all-ones. */
const formatId128 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("hex");

const flagNames = (
  raw: number,
  names: ReadonlyMap<number, string>,
): readonly string[] => {
  const result: string[] = [];
  for (const [bit, name] of names) if ((raw & bit) !== 0) result.push(name);
  return result;
};

const align8 = (value: number): number =>
  Math.ceil(value / JOURNAL_OBJECT_ALIGNMENT) * JOURNAL_OBJECT_ALIGNMENT;

const hasJournalSignature = (prefix: Uint8Array): boolean =>
  prefix.length >= JOURNAL_SIGNATURE_BYTES &&
  Buffer.from(prefix.subarray(0, JOURNAL_SIGNATURE_BYTES)).toString(
    "latin1",
  ) === JOURNAL_SIGNATURE;

/** A declared header length that can anchor the object area at all. */
const isUsableHeaderSize = (declared: bigint, fileBytes: number): boolean =>
  declared >= BigInt(JOURNAL_HEADER_MIN_BYTES) &&
  declared % BigInt(JOURNAL_OBJECT_ALIGNMENT) === 0n &&
  declared <= BigInt(fileBytes);

/**
 * Recognize a journal header by its signature alone. Whether `header_size`
 * anchors an object area is the owning reader's decision: a damaged header still
 * holds readable facts and deserves the reader's explicit limitation, so
 * rejecting it here would route the file to ordinary inventory instead.
 */
export const hasSystemdJournalHeader = (prefix: Uint8Array): boolean =>
  hasJournalSignature(prefix);

/**
 * Read a little-endian 64-bit field as a JS number. A value beyond
 * `Number.MAX_SAFE_INTEGER` cannot be held exactly, so the ceiling is reported
 * and the field name is recorded rather than claiming an exact source value.
 */
const readUint64 = (
  view: BinaryReader,
  offset: number,
  field: string,
  overflowed: string[],
): number => {
  const value = view.word(offset, 64);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    overflowed.push(field);
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(value);
};

/** One reading of the state byte, whether or not the object area is anchored. */
const readState = (view: BinaryReader): string =>
  JOURNAL_STATES.get(view.bytes[HEADER.state]!) ??
  `unknown-${String(view.bytes[HEADER.state]!)}`;

const readFlagFacts = (view: BinaryReader) => {
  const compatibleFlags = view.u32(HEADER.compatibleFlags);
  const incompatibleFlags = view.u32(HEADER.incompatibleFlags);
  return {
    compatible_flags: compatibleFlags,
    compatible_flag_names: flagNames(compatibleFlags, COMPATIBLE_FLAGS),
    incompatible_flags: incompatibleFlags,
    incompatible_flag_names: flagNames(incompatibleFlags, INCOMPATIBLE_FLAGS),
  };
};

const readIdFacts = (bytes: Uint8Array, compatibleFlags: number) => ({
  file_id: formatId128(bytes.subarray(HEADER.fileId, HEADER.fileId + 16)),
  machine_id: formatId128(
    bytes.subarray(HEADER.machineId, HEADER.machineId + 16),
  ),
  // Bytes 56-71 are the legacy boot id unless `tail-entry-boot-id` is set.
  // Both readings keep the source value; only which name it carries changes.
  tail_entry_boot_id:
    (compatibleFlags & COMPATIBLE_TAIL_ENTRY_BOOT_ID) !== 0
      ? formatId128(
          bytes.subarray(HEADER.tailEntryBootId, HEADER.tailEntryBootId + 16),
        )
      : null,
  boot_id:
    (compatibleFlags & COMPATIBLE_TAIL_ENTRY_BOOT_ID) !== 0
      ? null
      : formatId128(
          bytes.subarray(HEADER.tailEntryBootId, HEADER.tailEntryBootId + 16),
        ),
  seqnum_id: formatId128(bytes.subarray(HEADER.seqnumId, HEADER.seqnumId + 16)),
});

/** Facts for a header too short to anchor its object area; only what was read holds. */
const unanchoredHeader = (
  view: BinaryReader,
  bytes: Uint8Array,
  declaredHeaderSize: number,
): JournalHeaderFacts => ({
  ...readFlagFacts(view),
  ...readIdFacts(bytes, view.u32(HEADER.compatibleFlags)),
  // The state byte sits inside the probe, so it is observed even here.
  state: readState(view),
  header_size: declaredHeaderSize,
  arena_size: 0,
  data_hash_table_offset: 0,
  data_hash_table_size: 0,
  field_hash_table_offset: 0,
  field_hash_table_size: 0,
  tail_object_offset: 0,
  n_objects: 0,
  n_entries: 0,
  tail_entry_seqnum: 0,
  head_entry_seqnum: 0,
  entry_array_offset: 0,
  head_entry_realtime: 0,
  tail_entry_realtime: 0,
  tail_entry_monotonic: 0,
  n_data: null,
  n_fields: null,
  n_tags: null,
  n_entry_arrays: null,
  data_hash_chain_depth: null,
  field_hash_chain_depth: null,
  tail_entry_array_offset: null,
  tail_entry_array_n_entries: null,
  tail_entry_offset: null,
  // Every numeric declaration above is unread, not zero: the probe stopped
  // before them, so callers must not read these as observed values.
  unread_fields: UNREAD_HEADER_FIELDS,
  overflowed_fields: [],
});

/** Every header field inside `declaredHeaderSize`; later fields stay absent. */
const readHeaderFacts = (
  view: BinaryReader,
  bytes: Uint8Array,
  declaredHeaderSize: number,
): JournalHeaderFacts => {
  const overflowed: string[] = [];
  const u64 = (offset: number, field: string): number =>
    readUint64(view, offset, field, overflowed);
  /** `JOURNAL_HEADER_CONTAINS`: a field exists only inside the declared header. */
  const covers = (offset: number, size: number): boolean =>
    declaredHeaderSize >= offset + size;
  const optional = (offset: number, size: number, field: string) =>
    covers(offset, size) ? u64(offset, field) : null;
  const flags = readFlagFacts(view);
  return {
    ...flags,
    ...readIdFacts(bytes, flags.compatible_flags),
    state: readState(view),
    header_size: declaredHeaderSize,
    arena_size: u64(HEADER.arenaSize, "arena_size"),
    data_hash_table_offset: u64(
      HEADER.dataHashTableOffset,
      "data_hash_table_offset",
    ),
    data_hash_table_size: u64(HEADER.dataHashTableSize, "data_hash_table_size"),
    field_hash_table_offset: u64(
      HEADER.fieldHashTableOffset,
      "field_hash_table_offset",
    ),
    field_hash_table_size: u64(
      HEADER.fieldHashTableSize,
      "field_hash_table_size",
    ),
    tail_object_offset: u64(HEADER.tailObjectOffset, "tail_object_offset"),
    n_objects: u64(HEADER.nObjects, "n_objects"),
    n_entries: u64(HEADER.nEntries, "n_entries"),
    tail_entry_seqnum: u64(HEADER.tailEntrySeqnum, "tail_entry_seqnum"),
    head_entry_seqnum: u64(HEADER.headEntrySeqnum, "head_entry_seqnum"),
    entry_array_offset: u64(HEADER.entryArrayOffset, "entry_array_offset"),
    head_entry_realtime: u64(HEADER.headEntryRealtime, "head_entry_realtime"),
    tail_entry_realtime: u64(HEADER.tailEntryRealtime, "tail_entry_realtime"),
    tail_entry_monotonic: u64(
      HEADER.tailEntryMonotonic,
      "tail_entry_monotonic",
    ),
    n_data: optional(HEADER.nData, 8, "n_data"),
    n_fields: optional(HEADER.nFields, 8, "n_fields"),
    n_tags: optional(HEADER.nTags, 8, "n_tags"),
    n_entry_arrays: optional(HEADER.nEntryArrays, 8, "n_entry_arrays"),
    data_hash_chain_depth: optional(
      HEADER.dataHashChainDepth,
      8,
      "data_hash_chain_depth",
    ),
    field_hash_chain_depth: optional(
      HEADER.fieldHashChainDepth,
      8,
      "field_hash_chain_depth",
    ),
    // Added in 252 as two adjacent 32-bit members, unlike every other field here.
    tail_entry_array_offset: covers(HEADER.tailEntryArrayOffset, 4)
      ? view.u32(HEADER.tailEntryArrayOffset)
      : null,
    tail_entry_array_n_entries: covers(HEADER.tailEntryArrayNEntries, 4)
      ? view.u32(HEADER.tailEntryArrayNEntries)
      : null,
    tail_entry_offset: optional(HEADER.tailEntryOffset, 8, "tail_entry_offset"),
    unread_fields: [],
    overflowed_fields: overflowed,
  };
};

/** Map an object header's type byte to a stable name, never dropping unknown values. */
const describeObjectType = (raw: number): string => {
  const type = raw & OBJECT_TYPE_MASK;
  return OBJECT_TYPES.get(type) ?? `unknown-${String(type)}`;
};

type ScanPhase = "header" | "objects" | "skipping" | "closed";

/**
 * Walk the object chain front to back as the file streams past.
 *
 * The chain is sequential, so payload bytes are discarded as they arrive
 * rather than retained: a multi-gigabyte journal inventories in chunk-sized
 * memory, and every `write` call does bounded work so cancellation between
 * chunks is never queued behind a whole-file parse.
 */
class JournalScanner {
  readonly #fileBytes: number;
  /** Index of the first object header this window retains. */
  readonly #objectHeaderStart: number;
  readonly #headerBytes = new Uint8Array(JOURNAL_HEADER_BYTES);
  /** How many header bytes this reader consumes; the rest are discarded unread. */
  #headerTarget = JOURNAL_HEADER_SIZE_PROBE_BYTES;
  #headerFilled = 0; // not-an-allowance: cursor over the header bytes already read.
  #phase: ScanPhase = "header";
  /** True while the just-filled bytes were the 96-byte probe, not the whole header. */
  #resolvingProbe = true;

  /** Absolute file offset of the next object header, once the walk starts. */
  #offset = 0;
  #skipRemaining = 0; // not-an-allowance: bytes still to skip, not a resource allowance.
  readonly #objectHeader = new Uint8Array(JOURNAL_OBJECT_HEADER_BYTES);
  #objectHeaderFilled = 0;

  #header: JournalHeaderFacts | null = null;
  #refusal: RegionDecodeFailure | null = null;
  readonly #objectHeaders: JournalObjectHeader[] = [];
  readonly #typeCounts = new Map<string, number>();
  readonly #limitations: string[] = [];
  #objectCount = 0;
  #validCount = 0;
  #truncatedCount = 0;
  #unknownTypeCount = 0;
  #compressedCount = 0;
  #overflowedObjectCount = 0;
  /** Objects that declared fewer bytes than their own 16-byte header. */
  #undersizedObjectCount = 0;
  /** True when the chain stopped because the declared tail object was reached. */
  #tailReached = false;
  /** The header declared an empty object chain (n_objects 0, tail offset 0). */
  #emptyChainDeclared = false;
  /** Objects whose declared extent reaches past the declared arena. */
  #outsideArenaCount = 0;
  /** End of the last object that fit the file; the tail begins there or later. */
  #lastObjectEnd = 0;
  /** Absolute offset the declared arena ends at, or null when unread. */
  #arenaEnd: number | null = null;
  #tailObjectOffset: bigint | null = null;

  constructor(fileBytes: number, objectHeaderStart: number) {
    this.#fileBytes = fileBytes;
    this.#objectHeaderStart = objectHeaderStart;
    this.#lastObjectEnd = 0;
  }

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    let index = 0;
    while (index < chunk.length) {
      if (this.#phase === "closed") return ok(undefined);
      if (this.#phase === "header") {
        index = this.#consumeHeader(chunk, index);
      } else if (this.#phase === "skipping") {
        const take = Math.min(this.#skipRemaining, chunk.length - index);
        this.#skipRemaining -= take;
        index += take;
        if (this.#skipRemaining === 0) this.#phase = "objects";
      } else {
        const take = Math.min(
          JOURNAL_OBJECT_HEADER_BYTES - this.#objectHeaderFilled,
          chunk.length - index,
        );
        this.#objectHeader.set(
          chunk.subarray(index, index + take),
          this.#objectHeaderFilled,
        );
        this.#objectHeaderFilled += take;
        index += take;
        if (this.#objectHeaderFilled === JOURNAL_OBJECT_HEADER_BYTES) {
          this.#objectHeaderFilled = 0;
          this.#acceptObjectHeader();
        }
      }
    }
    return ok(undefined);
  }

  /** Consume header bytes and return the caller's chunk cursor. */
  #consumeHeader(chunk: Uint8Array, index: number): number {
    let cursor = index;
    for (;;) {
      const take = Math.min(
        this.#headerTarget - this.#headerFilled,
        chunk.length - cursor,
      );
      this.#headerBytes.set(
        chunk.subarray(cursor, cursor + take),
        this.#headerFilled,
      );
      this.#headerFilled += take;
      cursor += take;
      if (this.#headerFilled < this.#headerTarget) return cursor;
      if (this.#resolvingProbe) {
        this.#resolvingProbe = false;
        this.#resolveHeaderTarget();
        // A usable header is always longer than the probe, so keep reading.
        if (this.#header !== null || this.#refusal !== null) return cursor;
        if (this.#headerTarget > this.#headerFilled) continue;
        this.#finishHeader();
        return cursor;
      }
      this.#finishHeader();
      return cursor;
    }
  }

  /** Decide how much of the header this file declares, or stop the walk. */
  #resolveHeaderTarget(): void {
    const view = new BinaryReader(
      Buffer.from(
        this.#headerBytes.buffer,
        this.#headerBytes.byteOffset,
        JOURNAL_HEADER_SIZE_PROBE_BYTES,
      ),
      true,
      "systemd-journal",
    );
    const declared = view.word(HEADER.headerSize, 64);
    if (!isUsableHeaderSize(declared, this.#fileBytes)) {
      this.#limitations.push(
        `the header declares header_size ${declared.toString()}, which is not an aligned ${String(JOURNAL_HEADER_MIN_BYTES)}-byte-or-longer offset inside the ${String(this.#fileBytes)}-byte file; object headers were not walked`,
      );
      this.#header = unanchoredHeader(
        view,
        this.#headerBytes,
        declared > BigInt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER
          : Number(declared),
      );
      this.#phase = "closed";
      return;
    }
    this.#headerTarget = Math.min(Number(declared), JOURNAL_HEADER_BYTES);
  }

  #finishHeader(): void {
    const declared = readUint64(
      new BinaryReader(
        Buffer.from(
          this.#headerBytes.buffer,
          this.#headerBytes.byteOffset,
          this.#headerBytes.byteLength,
        ),
        true,
        "systemd-journal",
      ),
      HEADER.headerSize,
      "header_size",
      [],
    );
    const view = new BinaryReader(
      Buffer.from(
        this.#headerBytes.buffer,
        this.#headerBytes.byteOffset,
        this.#headerTarget,
      ),
      true,
      "systemd-journal",
    );
    const header = readHeaderFacts(
      view,
      this.#headerBytes.subarray(0, this.#headerTarget),
      declared,
    );
    this.#header = header;
    // Zero is a known arena size (an empty arena), not an absent one, so every
    // read header bounds its objects; an overflowed size is not exact.
    this.#arenaEnd =
      header.unread_fields.length === 0 &&
      !header.overflowed_fields.includes("arena_size")
        ? declared + header.arena_size
        : null;
    this.#offset = declared;
    this.#lastObjectEnd = declared;
    // `tail_object_offset` is 0 both for a journal whose object chain is empty
    // and for one that never recorded a tail; only the declaration of zero
    // objects makes it an empty chain. A non-empty chain with a zero tail is
    // walked to its end, where its own object count bounds it.
    this.#emptyChainDeclared =
      header.n_objects === 0 && header.tail_object_offset === 0;
    this.#tailObjectOffset =
      this.#emptyChainDeclared || header.tail_object_offset === 0
        ? null
        : BigInt(header.tail_object_offset);
    const unknownFlags = header.incompatible_flags & ~INCOMPATIBLE_FLAGS_KNOWN;
    if (unknownFlags !== 0) {
      // The file is complete: the header itself says its layout is one this
      // reader does not implement. Truncation would misdirect the caller
      // towards obtaining another copy instead of a compatible decoder.
      this.#refusal = unsupported(
        `the header sets incompatible flag bit(s) 0x${unknownFlags.toString(16)} outside the known set, so its object layout is not one this reader can interpret`,
      );
      this.#phase = "closed";
      return;
    }
    if (header.overflowed_fields.length > 0)
      this.#limitations.push(
        `header field(s) ${header.overflowed_fields.join(", ")} declare a value above 2^53-1 and are reported as ${String(Number.MAX_SAFE_INTEGER)}`,
      );
    // Header bytes past the current struct belong to a newer revision; skip them.
    this.#skipRemaining = declared - this.#headerTarget;
    this.#phase = this.#skipRemaining > 0 ? "skipping" : "objects";
  }

  #acceptObjectHeader(): void {
    const offset = this.#offset;
    // A declared empty chain has no objects to walk; the first 16 bytes past
    // the header are preallocated capacity, not an object header.
    if (this.#emptyChainDeclared) {
      this.#phase = "closed";
      return;
    }
    if (
      this.#tailObjectOffset !== null &&
      BigInt(offset) > this.#tailObjectOffset
    ) {
      this.#limitations.push(
        `the object chain continues past the declared tail object at ${this.#tailObjectOffset.toString()}; later objects are not inspected`,
      );
      this.#phase = "closed";
      return;
    }
    if (offset + JOURNAL_OBJECT_HEADER_BYTES > this.#fileBytes) {
      this.#phase = "closed";
      return;
    }
    const view = new BinaryReader(
      Buffer.from(
        this.#objectHeader.buffer,
        this.#objectHeader.byteOffset,
        this.#objectHeader.byteLength,
      ),
      true,
      "systemd-journal",
    );
    const rawType = view.bytes[0]!;
    const flags = view.bytes[1]!;
    /** An object's declared size counts its own 16-byte header. */
    const declaredSize = view.word(8, 64);
    const type = describeObjectType(rawType);
    const sizeOverflowed = declaredSize > BigInt(Number.MAX_SAFE_INTEGER);
    const object: JournalObjectHeader = {
      offset,
      type,
      raw_type: rawType,
      flags,
      flag_names: flagNames(flags, OBJECT_FLAG_NAMES),
      size: sizeOverflowed ? Number.MAX_SAFE_INTEGER : Number(declaredSize),
      size_overflowed: sizeOverflowed,
      compressed: (flags & OBJECT_COMPRESSED_MASK) !== 0,
    };
    if (sizeOverflowed) this.#overflowedObjectCount += 1;
    const index = this.#objectCount;
    this.#objectCount += 1;
    this.#typeCounts.set(type, (this.#typeCounts.get(type) ?? 0) + 1);
    if (!OBJECT_TYPES.has(rawType & OBJECT_TYPE_MASK))
      this.#unknownTypeCount += 1;
    if (object.compressed) this.#compressedCount += 1;
    if (index >= this.#objectHeaderStart) {
      if (this.#objectHeaders.length < JOURNAL_INLINE_OBJECT_LIMIT)
        this.#objectHeaders.push(object);
    }

    // A declared size below the 16-byte header is a self-contradictory
    // declaration, not a file cut short: no bytes are missing. Counting it as
    // truncation would tell the analyst the writer was interrupted.
    if (declaredSize < BigInt(JOURNAL_OBJECT_HEADER_BYTES)) {
      this.#undersizedObjectCount += 1;
      this.#phase = "closed";
      return;
    }
    if (declaredSize > BigInt(this.#fileBytes - offset)) {
      this.#truncatedCount += 1;
      this.#phase = "closed";
      return;
    }
    // The arena is the object area the header declares. An object that ends
    // past its end describes bytes outside the arena, which the physical file
    // alone cannot detect when the arena is short.
    if (
      this.#arenaEnd !== null &&
      offset + Number(declaredSize) > this.#arenaEnd
    ) {
      this.#outsideArenaCount += 1;
      this.#phase = "closed";
      return;
    }
    this.#validCount += 1;
    this.#lastObjectEnd = offset + Number(declaredSize);
    if (
      this.#tailObjectOffset !== null &&
      BigInt(offset) === this.#tailObjectOffset
    ) {
      this.#tailReached = true;
      this.#phase = "closed";
      return;
    }
    // systemd aligns the next object's start; the declared size stays unpadded.
    const nextOffset = align8(this.#lastObjectEnd);
    if (nextOffset + JOURNAL_OBJECT_HEADER_BYTES > this.#fileBytes) {
      this.#phase = "closed";
      return;
    }
    this.#skipRemaining = nextOffset - offset - JOURNAL_OBJECT_HEADER_BYTES;
    this.#offset = nextOffset;
    this.#phase = this.#skipRemaining > 0 ? "skipping" : "objects";
  }

  finish(): Result<JournalInventory, RegionDecodeFailure> {
    if (this.#refusal !== null) return err(this.#refusal);
    if (this.#fileBytes < JOURNAL_HEADER_MIN_BYTES)
      return err(
        failure(
          `file is ${String(this.#fileBytes)} bytes, shorter than the ${String(JOURNAL_HEADER_MIN_BYTES)}-byte journal header`,
        ),
      );
    if (!hasJournalSignature(this.#headerBytes))
      return err(failure('file does not begin with the "LPKSHHRH" signature'));
    const header = this.#header;
    if (header === null)
      return err(failure("stream ended before the journal header was read"));
    // A declared tail the walk never reached: the chain stopped at a damaged
    // or truncated object, or at EOF, before the offset the header names.
    const tailUnreached =
      !this.#emptyChainDeclared &&
      this.#tailObjectOffset !== null &&
      this.#tailObjectOffset <= BigInt(Number.MAX_SAFE_INTEGER) &&
      !this.#tailReached &&
      Number(this.#tailObjectOffset) > this.#lastObjectEnd;

    if (header.header_size > 0) {
      if (this.#objectCount !== header.n_objects)
        this.#limitations.push(
          `the header declares ${String(header.n_objects)} object(s) but the object chain yielded ${String(this.#objectCount)} readable object header(s)`,
        );
      if (this.#truncatedCount > 0)
        this.#limitations.push(
          "the object chain ends at an object whose declared size does not fit the file; its payload is not covered",
        );
      if (this.#undersizedObjectCount > 0)
        this.#limitations.push(
          `${String(this.#undersizedObjectCount)} object(s) declare a size below the 16-byte object header, which is a self-contradictory declaration rather than a file cut short; no bytes of theirs are covered`,
        );
      if (this.#overflowedObjectCount > 0)
        this.#limitations.push(
          `${String(this.#overflowedObjectCount)} object(s) declare a size above 2^53-1 and are reported with that ceiling and \`size_overflowed: true\``,
        );
      // `header_size + arena_size` is the used extent the writer declares; a
      // file shorter than that is missing arena bytes even when every readable
      // object and count agrees.
      if (this.#arenaEnd !== null && this.#arenaEnd > this.#fileBytes)
        this.#limitations.push(
          `the header declares an arena ending at ${String(this.#arenaEnd)}, past the ${String(this.#fileBytes)}-byte file; ${String(this.#arenaEnd - this.#fileBytes)} declared arena byte(s) are absent`,
        );
      if (this.#outsideArenaCount > 0)
        this.#limitations.push(
          `${String(this.#outsideArenaCount)} object(s) declare an extent past the end of the arena the header declares; the object chain stops there`,
        );
      if (tailUnreached)
        this.#limitations.push(
          `the header declares a tail object at ${String(this.#tailObjectOffset)} that the walked chain never reached; the object area is not complete`,
        );
      if (this.#unknownTypeCount > 0)
        this.#limitations.push(
          `${String(this.#unknownTypeCount)} object header(s) declare a type outside the known range`,
        );
      if (this.#compressedCount > 0)
        this.#limitations.push(
          "compressed object payloads are not decompressed, so their field values are not decoded",
        );
      else if (
        header.incompatible_flag_names.some((name) =>
          name.startsWith("compressed-"),
        )
      )
        this.#limitations.push(
          "the header advertises a compression algorithm, but no walked object carries a compression flag, so no payload needed decompression",
        );
    }

    return ok({
      metadata: {
        kind: "systemd-journal",
        header,
        object_count: this.#objectCount,
        valid_object_count: this.#validCount,
        truncated_object_count: this.#truncatedCount,
        unknown_type_object_count: this.#unknownTypeCount,
        object_type_counts: [...this.#typeCounts]
          .map(([type, count]) => ({ type, count }))
          .sort((left, right) => (left.type < right.type ? -1 : 1)),
        object_headers: this.#objectHeaders,
        omitted_object_headers: Math.max(
          0,
          this.#objectCount - this.#objectHeaders.length,
        ),
        trailing_bytes: Math.max(
          0,
          this.#fileBytes - align8(this.#lastObjectEnd),
        ),
      },
      limitations: objectPayloadLimitations(this.#limitations),
    });
  }
}

/** Object headers describe the file's layout; field and entry semantics are a later step. */
const objectPayloadLimitations = (limitations: readonly string[]) => [
  ...limitations,
  "object payloads are inventoried by header only: fields, entries, entry arrays and hash tables are not decoded, entry times and boot/session filters are not available",
];

/**
 * The scan streams and retains a bounded window, so no whole-file ceiling is
 * needed: memory is one chunk plus `JOURNAL_INLINE_OBJECT_LIMIT` headers
 * whatever the file size. `objectHeaderStart` selects the window a page reads,
 * so headers past the first window stay retrievable without retaining them.
 */
export const createJournalDecoder = (
  fileBytes: number,
  objectHeaderStart = 0,
): Result<RegionDecoder<JournalInventory>, RegionDecodeFailure> =>
  Number.isSafeInteger(fileBytes) &&
  fileBytes >= 0 &&
  Number.isSafeInteger(objectHeaderStart) &&
  objectHeaderStart >= 0
    ? ok(new JournalScanner(fileBytes, objectHeaderStart))
    : err(
        failure(
          `file size ${String(fileBytes)} and object header start ${String(objectHeaderStart)} must be non-negative safe integers`,
        ),
      );
