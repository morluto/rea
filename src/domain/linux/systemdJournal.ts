import { err, ok, type Result } from "../result.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/** Every systemd journal file begins with this signature. */
const JOURNAL_SIGNATURE = "LPKSHHRH";
const JOURNAL_SIGNATURE_BYTES = 8;
/**
 * The header is a fixed 272-byte struct. Fields appended in later format
 * revisions are read only when the declared header covers them.
 */
const JOURNAL_HEADER_BYTES = 272;
const JOURNAL_HEADER_WITH_N_OBJECTS_BYTES = 8 + 8 + 8 + 8 + 16 + 16 + 16 + 16;
/** Objects start at the header's end and are 8-byte aligned. */
const JOURNAL_OBJECT_ALIGNMENT = 8;
const JOURNAL_OBJECT_HEADER_BYTES = 16;
/** `ENTRY_SIZE_MAX`, so a single entry can never exceed this even on a huge journal. */
export const JOURNAL_MAX_FILE_BYTES = 1024 * 1024 * 1024 * 4;
/** Inline object headers are a sample; the whole object chain is still walked. */
export const JOURNAL_INLINE_OBJECT_LIMIT = 32;
const JOURNAL_MAX_INLINE_OBJECTS = JOURNAL_INLINE_OBJECT_LIMIT;

/** Header flag bits that change how the object area must be read. */
const INCOMPATIBLE_FLAGS = new Map<number, string>([
  [1 << 0, "compressed-xz"],
  [1 << 1, "compressed-lz4"],
  [1 << 2, "keyed-hash"],
  [1 << 3, "compressed-zstd"],
  [1 << 4, "compact"],
]);
const COMPATIBLE_FLAGS = new Map<number, string>([
  [1 << 0, "sealed"],
  [1 << 1, "tail-entry-boot-id"],
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

export interface JournalHeaderFacts {
  readonly compatible_flags: number;
  readonly compatible_flag_names: readonly string[];
  readonly incompatible_flags: number;
  readonly incompatible_flag_names: readonly string[];
  readonly state: string;
  readonly file_id: string;
  readonly machine_id: string;
  readonly tail_entry_boot_id: string;
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
  readonly n_data: number;
  readonly n_fields: number;
  readonly n_tags: number;
  readonly n_entry_arrays: number;
  readonly data_hash_chain_depth: number;
  readonly field_hash_chain_depth: number;
  readonly tail_entry_array_offset: number;
  readonly tail_entry_array_n_entries: number;
  readonly tail_entry_offset: number;
}

export interface JournalObjectHeader {
  /** File offset where the object's 16-byte header starts. */
  readonly offset: number;
  readonly type: string;
  readonly raw_type: number;
  readonly flags: number;
  readonly flag_names: readonly string[];
  readonly size: number;
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
  readonly omitted_object_headers: number;
  readonly object_header_start_index: number;
  readonly next_object_header_index: number | null;
  /** Bytes after the last valid object; a journal is written front to back. */
  readonly trailing_bytes: number;
}

const failure = (
  message: string,
  boundary?: RegionDecodeFailure["boundary"],
): RegionDecodeFailure => ({
  kind: "format",
  message,
  ...(boundary === undefined ? {} : { boundary }),
});

const limit = (
  message: string,
  boundary?: RegionDecodeFailure["boundary"],
): RegionDecodeFailure => ({
  kind: "limit",
  message,
  ...(boundary === undefined ? {} : { boundary }),
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

const hasJournalSignature = (prefix: Uint8Array): boolean =>
  prefix.length >= JOURNAL_SIGNATURE_BYTES &&
  Buffer.from(prefix.subarray(0, JOURNAL_SIGNATURE_BYTES)).toString(
    "latin1",
  ) === JOURNAL_SIGNATURE;

/** Recognize a journal header without requiring its object area to verify. */
export const hasSystemdJournalHeader = (prefix: Uint8Array): boolean => {
  if (!hasJournalSignature(prefix) || prefix.length < JOURNAL_HEADER_BYTES)
    return false;
  const view = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  );
  const headerSize = readUint64(view, HEADER.headerSize);
  return (
    headerSize >= JOURNAL_HEADER_BYTES &&
    headerSize % JOURNAL_OBJECT_ALIGNMENT === 0 &&
    headerSize <= prefix.length
  );
};

/**
 * Read a little-endian 64-bit field as a JS number. Values beyond
 * `Number.MAX_SAFE_INTEGER` are reported as that ceiling so a corrupt size
 * cannot silently alias a small offset.
 */
const readUint64 = (view: DataView, offset: number): number => {
  const value = view.getBigUint64(offset, true);
  return value > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(value);
};

const readHeaderFacts = (
  view: DataView,
  bytes: Uint8Array,
): JournalHeaderFacts => {
  const compatibleFlags = view.getUint32(HEADER.compatibleFlags, true);
  const incompatibleFlags = view.getUint32(HEADER.incompatibleFlags, true);
  return {
    compatible_flags: compatibleFlags,
    compatible_flag_names: flagNames(compatibleFlags, COMPATIBLE_FLAGS),
    incompatible_flags: incompatibleFlags,
    incompatible_flag_names: flagNames(incompatibleFlags, INCOMPATIBLE_FLAGS),
    state:
      JOURNAL_STATES.get(view.getUint8(HEADER.state)) ??
      `unknown-${String(view.getUint8(HEADER.state))}`,
    file_id: formatId128(bytes.subarray(HEADER.fileId, HEADER.fileId + 16)),
    machine_id: formatId128(
      bytes.subarray(HEADER.machineId, HEADER.machineId + 16),
    ),
    tail_entry_boot_id: formatId128(
      bytes.subarray(HEADER.tailEntryBootId, HEADER.tailEntryBootId + 16),
    ),
    seqnum_id: formatId128(
      bytes.subarray(HEADER.seqnumId, HEADER.seqnumId + 16),
    ),
    header_size: readUint64(view, HEADER.headerSize),
    arena_size: readUint64(view, HEADER.arenaSize),
    data_hash_table_offset: readUint64(view, HEADER.dataHashTableOffset),
    data_hash_table_size: readUint64(view, HEADER.dataHashTableSize),
    field_hash_table_offset: readUint64(view, HEADER.fieldHashTableOffset),
    field_hash_table_size: readUint64(view, HEADER.fieldHashTableSize),
    tail_object_offset: readUint64(view, HEADER.tailObjectOffset),
    n_objects: readUint64(view, HEADER.nObjects),
    n_entries: readUint64(view, HEADER.nEntries),
    tail_entry_seqnum: readUint64(view, HEADER.tailEntrySeqnum),
    head_entry_seqnum: readUint64(view, HEADER.headEntrySeqnum),
    entry_array_offset: readUint64(view, HEADER.entryArrayOffset),
    head_entry_realtime: readUint64(view, HEADER.headEntryRealtime),
    tail_entry_realtime: readUint64(view, HEADER.tailEntryRealtime),
    tail_entry_monotonic: readUint64(view, HEADER.tailEntryMonotonic),
    n_data: readUint64(view, HEADER.nData),
    n_fields: readUint64(view, HEADER.nFields),
    n_tags: readUint64(view, HEADER.nTags),
    n_entry_arrays: readUint64(view, HEADER.nEntryArrays),
    data_hash_chain_depth: readUint64(view, HEADER.dataHashChainDepth),
    field_hash_chain_depth: readUint64(view, HEADER.fieldHashChainDepth),
    tail_entry_array_offset: readUint64(view, HEADER.tailEntryArrayOffset),
    tail_entry_array_n_entries: readUint64(view, HEADER.tailEntryArrayNEntries),
    tail_entry_offset: readUint64(view, HEADER.tailEntryOffset),
  };
};

/** Map an object header's type byte to a stable name, never dropping unknown values. */
const describeObjectType = (raw: number): string => {
  const type = raw & OBJECT_TYPE_MASK;
  return OBJECT_TYPES.get(type) ?? `unknown-${String(type)}`;
};

/**
 * Walk the object chain front to back. The header's `n_objects` is a
 * declaration; the chain is only as trustworthy as the extents it can read,
 * so both are reported.
 */
const scanJournal = (
  bytes: Uint8Array,
  window = { startObject: 0, objectLimit: JOURNAL_MAX_INLINE_OBJECTS },
): Result<JournalInventory, RegionDecodeFailure> => {
  if (bytes.length < JOURNAL_HEADER_BYTES)
    return err(
      failure(
        `file is ${String(bytes.length)} bytes, shorter than the fixed ${String(JOURNAL_HEADER_BYTES)}-byte journal header`,
      ),
    );
  if (!hasJournalSignature(bytes))
    return err(failure('file does not begin with the "LPKSHHRH" signature'));

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readHeaderFacts(view, bytes);
  const limitations: string[] = [];
  const headerSize = header.header_size;
  const headerOk =
    headerSize >= JOURNAL_HEADER_BYTES &&
    headerSize % JOURNAL_OBJECT_ALIGNMENT === 0 &&
    headerSize <= bytes.length;
  if (!headerOk)
    limitations.push(
      `the header declares header_size ${String(headerSize)}, which is not an aligned ${String(JOURNAL_HEADER_BYTES)}-byte-or-longer offset inside the ${String(bytes.length)}-byte file; object headers were not walked`,
    );

  const objectHeaders: JournalObjectHeader[] = [];
  const typeCounts = new Map<string, number>();
  let objectCount = 0;
  let validCount = 0;
  let truncatedCount = 0;
  let unknownTypeCount = 0;
  let compressedCount = 0;
  let trailingBytes = 0;
  let nextObjectHeaderIndex: number | null = null;

  if (headerOk) {
    let offset = headerSize;
    for (;;) {
      if (offset + JOURNAL_OBJECT_HEADER_BYTES > bytes.length) {
        trailingBytes = bytes.length - offset;
        break;
      }
      const rawType = view.getUint8(offset);
      const flags = view.getUint8(offset + 1);
      /** An object's declared size counts its own 16-byte header. */
      const size = readUint64(view, offset + 8);
      const type = describeObjectType(rawType);
      const object: JournalObjectHeader = {
        offset,
        type,
        raw_type: rawType,
        flags,
        flag_names: flagNames(flags, OBJECT_FLAG_NAMES),
        size,
        compressed: (flags & OBJECT_COMPRESSED_MASK) !== 0,
      };
      const index = objectCount;
      objectCount += 1;
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
      if (!OBJECT_TYPES.has(rawType & OBJECT_TYPE_MASK)) unknownTypeCount += 1;
      if (object.compressed) compressedCount += 1;
      if (index >= window.startObject) {
        if (objectHeaders.length < window.objectLimit)
          objectHeaders.push(object);
        else nextObjectHeaderIndex ??= index;
      }

      if (
        size < JOURNAL_OBJECT_HEADER_BYTES ||
        size % JOURNAL_OBJECT_ALIGNMENT !== 0 ||
        offset + size > bytes.length
      ) {
        truncatedCount += 1;
        trailingBytes = bytes.length - offset;
        break;
      }
      validCount += 1;
      offset += size;
      if (offset === bytes.length) break;
    }
  }

  if (headerOk && objectCount !== header.n_objects)
    limitations.push(
      `the header declares ${String(header.n_objects)} object(s) but the object chain yielded ${String(objectCount)} readable object header(s)`,
    );
  if (truncatedCount > 0)
    limitations.push(
      "the object chain ends at an object whose declared size does not fit the file; its payload is not covered",
    );
  if (unknownTypeCount > 0)
    limitations.push(
      `${String(unknownTypeCount)} object header(s) declare a type outside the known range`,
    );
  if (compressedCount > 0 || header.incompatible_flag_names.length > 0)
    limitations.push(
      "compressed object payloads are not decompressed, so their field values are not decoded",
    );

  const metadata: JournalMetadata = {
    kind: "systemd-journal",
    header,
    object_count: objectCount,
    valid_object_count: validCount,
    truncated_object_count: truncatedCount,
    unknown_type_object_count: unknownTypeCount,
    object_type_counts: [...typeCounts]
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => (left.type < right.type ? -1 : 1)),
    object_headers: objectHeaders,
    omitted_object_headers: Math.max(0, objectCount - objectHeaders.length),
    object_header_start_index: window.startObject,
    next_object_header_index: nextObjectHeaderIndex,
    trailing_bytes: trailingBytes,
  };

  return ok({ metadata, limitations: objectPayloadLimitations(limitations) });
};

/** Object headers describe the file's layout; field and entry semantics are a later step. */
const objectPayloadLimitations = (limitations: readonly string[]) => [
  ...limitations,
  "object payloads are inventoried by header only: fields, entries, entry arrays and hash tables are not decoded, entry times and boot/session filters are not available",
];

/** Buffer the admitted input once while accepting arbitrary chunk boundaries. */
class StreamingJournalDecoder implements RegionDecoder<JournalInventory> {
  readonly #bytes: Uint8Array;
  #written = 0;

  constructor(fileBytes: number) {
    this.#bytes = new Uint8Array(fileBytes);
  }

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    if (chunk.length > this.#bytes.length - this.#written)
      return err(failure("received more bytes than the admitted file length"));
    this.#bytes.set(chunk, this.#written);
    this.#written += chunk.length;
    return ok(undefined);
  }

  finish(): Result<JournalInventory, RegionDecodeFailure> {
    if (this.#written !== this.#bytes.length)
      return err(failure("stream ended before the admitted file length"));
    return scanJournal(this.#bytes);
  }
}

export const createJournalDecoder = (
  fileBytes: number,
): Result<RegionDecoder<JournalInventory>, RegionDecodeFailure> =>
  Number.isSafeInteger(fileBytes) &&
  fileBytes >= 0 &&
  fileBytes <= JOURNAL_MAX_FILE_BYTES
    ? ok(new StreamingJournalDecoder(fileBytes))
    : err(
        limit(
          `file is ${String(fileBytes)} bytes, exceeding the fixed ${String(JOURNAL_MAX_FILE_BYTES)}-byte (4 GiB) ceiling`,
          "file-size",
        ),
      );
