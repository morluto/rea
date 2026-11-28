import { BinaryReader } from "./binaryContainer.js";
import { Budget } from "./budget.js";
import type {
  AmigaHunkEntryMetadata,
  AmigaHunkMetadata,
} from "./formatMetadata/packageAndGameMetadata.js";
import { decodeLimit, malformedInput, truncatedInput } from "./parseFailure.js";

/**
 * AmigaOS Hunk load files (`HUNK_HEADER`) and object files (`HUNK_UNIT`).
 * The walker reports hunks, relocation counts, symbol names and debug
 * presence. It does not apply relocations or join hunks into one image.
 *
 * Block type ids ignore bits 29-31 (advisory, chip, fast). A header size
 * word and an object-file code, data or BSS type word use bits 31-30 as
 * memory. Bits `11` consume the next longword as raw memory flags. Header
 * size bits 29-0 are the size in longwords. Load-file block types do not
 * carry memory; that comes from the header.
 *
 * In a load file, `HUNK_DREL32` (0x3F7) is the V37 short relocation block:
 * 16-bit counts, targets and offsets, padded like `HUNK_RELOC32SHORT`.
 * An object file keeps 32-bit `HUNK_DREL32`.
 */

const FORMAT = "amiga-hunk";

/** Representation bound. The walker checks every relocation offset. */
export const AMIGA_HUNK_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Representation bound, not an AmigaDOS maximum. */
const AMIGA_HUNK_MAX_HUNKS = 1024;
/** Relocations counted for one hunk. Offsets are not retained. */
const AMIGA_HUNK_MAX_RELOCATIONS = 65_536;
/** Distinct (kind, target) relocation records retained across the file. */
const AMIGA_HUNK_MAX_RELOCATION_RECORDS = 65_536;
/** Resident-library, hunk, symbol and object-file unit name bytes, padded longwords included. */
const AMIGA_HUNK_MAX_SYMBOL_BYTES = 65_536;

export const AMIGA_HUNK_HUNK_LIMIT = "amiga-hunk.hunks";
export const AMIGA_HUNK_RELOCATION_LIMIT = "amiga-hunk.relocations";
export const AMIGA_HUNK_RELOCATION_RECORD_LIMIT =
  "amiga-hunk.relocation-records";
export const AMIGA_HUNK_SYMBOL_LIMIT = "amiga-hunk.symbol-bytes";

export const HUNK_UNIT = 0x3e7;
export const HUNK_NAME = 0x3e8;
export const HUNK_CODE = 0x3e9;
export const HUNK_DATA = 0x3ea;
export const HUNK_BSS = 0x3eb;
export const HUNK_RELOC32 = 0x3ec;
export const HUNK_EXT = 0x3ef;
export const HUNK_SYMBOL = 0x3f0;
export const HUNK_DEBUG = 0x3f1;
export const HUNK_END = 0x3f2;
export const HUNK_HEADER = 0x3f3;
export const HUNK_DREL32 = 0x3f7;
export const HUNK_RELOC32SHORT = 0x3fc;

/** Bits 29-31 on a block type. Header size words do not use this mask. */
const HUNK_TYPE_MASK = 0x1fff_ffff;
export const HUNKF_ADVISORY = 0x2000_0000;
export const HUNKF_CHIP = 0x4000_0000;
export const HUNKF_FAST = 0x8000_0000;
export const HUNKF_EXTENDED = 0xc000_0000;
const HUNK_MEM_MASK = 0xc000_0000;
export const HUNK_SIZE_MASK = 0x3fff_ffff;
/** Last assigned classic hunk id, `HUNK_ABSRELOC16`. */
const HUNK_BLOCK_LAST = 0x3fe;
/** Between `HUNK_HEADER` (0x3F3) and `HUNK_OVERLAY` (0x3F5). Never assigned. */
const HUNK_BLOCK_UNASSIGNED = 0x3f4;

export interface AmigaHunkLimits {
  readonly maxHunks?: number;
  readonly maxRelocations?: number;
  readonly maxRelocationRecords?: number;
  readonly maxSymbolBytes?: number;
  /** Reader file admission. The block walker does not apply this. */
  readonly maxFileBytes?: number;
}

type AmigaHunkMemory = "any" | "chip" | "fast" | "extended";

interface DecodedMemoryFlags {
  readonly memory: AmigaHunkMemory;
  readonly extendedFlags: number | null;
}
type AmigaHunkBody = "code" | "data" | "bss";
type AmigaHunkRelocKind = "reloc32" | "reloc32short" | "drel32";
type AmigaHunkLimitationKind =
  | "unknown-block"
  | "truncated"
  | "missing-end"
  | "size-mismatch"
  | "relocation-target"
  | "relocation-offset"
  | "trailing-bytes"
  | "header"
  | "missing-body";

interface AmigaHunkLimitation {
  readonly kind: AmigaHunkLimitationKind;
  readonly offset: number;
  readonly detail: string;
}

interface AmigaHunkRelocation {
  readonly kind: AmigaHunkRelocKind;
  readonly targetHunk: number;
  readonly count: number;
}

interface AmigaHunkSymbol {
  readonly name: string;
  readonly offset: number;
}

interface AmigaHunk {
  readonly index: number;
  /** Object-file unit this hunk belongs to; null in a load file. */
  readonly unit: number | null;
  readonly type: AmigaHunkBody | null;
  readonly memory: AmigaHunkMemory;
  readonly extendedFlags: number | null;
  readonly declaredLongwords: number;
  readonly storedLongwords: number | null;
  readonly storedBytes: number | null;
  readonly fileOffset: number | null;
  readonly name: string | null;
  readonly relocations: readonly AmigaHunkRelocation[];
  readonly symbols: readonly AmigaHunkSymbol[];
  readonly debug: boolean;
  readonly debugLongwords: number;
}

interface AmigaHunkUnit {
  readonly index: number;
  readonly name: string;
  readonly offset: number;
}

export interface AmigaHunkEntry {
  readonly path: string;
  readonly role: "code" | "data";
  readonly hunk: number;
  readonly memory: AmigaHunkMemory;
  readonly declaredBytes: number;
  readonly storedBytes: number;
  readonly byteOffset: number;
}

export interface AmigaHunkFile {
  readonly fileKind: "load" | "object";
  readonly residentLibraries: readonly string[];
  readonly tableSize: number | null;
  readonly firstHunk: number | null;
  readonly lastHunk: number | null;
  readonly hunks: readonly AmigaHunk[];
  readonly units: readonly AmigaHunkUnit[];
  readonly limitations: readonly AmigaHunkLimitation[];
  readonly entries: readonly AmigaHunkEntry[];
}

const readWord = (prefix: Uint8Array, at: number): number | undefined => {
  if (at < 0 || prefix.length < at + 4) return undefined;
  return (
    (((prefix[at] ?? 0) << 24) |
      ((prefix[at + 1] ?? 0) << 16) |
      ((prefix[at + 2] ?? 0) << 8) |
      (prefix[at + 3] ?? 0)) >>>
    0
  );
};

/** Block types that may follow a unit name in an object file. */
const OBJECT_BLOCKS = new Set<number>([
  HUNK_UNIT,
  HUNK_NAME,
  HUNK_CODE,
  HUNK_DATA,
  HUNK_BSS,
  HUNK_RELOC32,
  HUNK_EXT,
  HUNK_SYMBOL,
  HUNK_DEBUG,
  HUNK_END,
  HUNK_DREL32,
  HUNK_RELOC32SHORT,
]);

/**
 * What a bounded prefix can decide about a Hunk header. `needs-prefix` means
 * the declared name is inside the parser's name allowance and the file, but
 * the prefix ends before the next structural word.
 */
export type AmigaHunkPrefixDecision =
  | { readonly state: "recognized" }
  | { readonly state: "needs-prefix"; readonly bytes: number };

const spanPastPrefix = (
  prefix: Uint8Array,
  fileSize: number,
  end: number,
): AmigaHunkPrefixDecision | undefined => {
  if (!Number.isSafeInteger(end) || end > fileSize) return undefined;
  if (end > prefix.length) return { state: "needs-prefix", bytes: end };
  return { state: "recognized" };
};

/**
 * A name the parser would retain. A longer declared name is not a Hunk header
 * this recognizer can distinguish from other bytes.
 */
const admittedNameBytes = (
  nlongs: number,
  used: number,
): number | undefined => {
  const bytes = nlongs * 4;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes > AMIGA_HUNK_MAX_SYMBOL_BYTES - used
  )
    return undefined;
  return bytes;
};

/**
 * A load or object header the parser accepts, or the prefix length that
 * header still needs. Library and unit names share the parser's name
 * allowance; the recognizer adds no smaller cutoff. A load file also needs
 * a hunk table whose last hunk indexes inside the table size. An object
 * file needs the unit name followed by a known block, or the end of the file.
 */
export const amigaHunkPrefixDecision = (
  prefix: Uint8Array,
  fileSize = prefix.length,
): AmigaHunkPrefixDecision | undefined => {
  const magic = readWord(prefix, 0);
  if (magic === HUNK_HEADER) return loadHeaderDecision(prefix, fileSize);
  if (magic === HUNK_UNIT) return objectUnitDecision(prefix, fileSize);
  return undefined;
};

/** True when the prefix itself holds a plausible Hunk header. */
export const hasAmigaHunkMagic = (
  prefix: Uint8Array,
  fileSize = prefix.length,
): boolean => amigaHunkPrefixDecision(prefix, fileSize)?.state === "recognized";

const loadHeaderDecision = (
  prefix: Uint8Array,
  fileSize: number,
): AmigaHunkPrefixDecision | undefined => {
  let at = 4;
  let used = 0;
  for (;;) {
    const count = spanPastPrefix(prefix, fileSize, at + 4);
    if (count?.state !== "recognized") return count;
    const nlongs = readWord(prefix, at);
    if (nlongs === undefined) return undefined;
    at += 4;
    if (nlongs === 0) break;
    const nameBytes = admittedNameBytes(nlongs, used);
    if (nameBytes === undefined) return undefined;
    used += nameBytes;
    const name = spanPastPrefix(prefix, fileSize, at + nameBytes);
    if (name?.state !== "recognized") return name;
    at += nameBytes;
  }
  const table = spanPastPrefix(prefix, fileSize, at + 12);
  if (table?.state !== "recognized") return table;
  const tableSize = readWord(prefix, at);
  const first = readWord(prefix, at + 4);
  const last = readWord(prefix, at + 8);
  if (tableSize === undefined || first === undefined || last === undefined)
    return undefined;
  return first <= last && last < tableSize
    ? { state: "recognized" }
    : undefined;
};

const objectUnitDecision = (
  prefix: Uint8Array,
  fileSize: number,
): AmigaHunkPrefixDecision | undefined => {
  const count = spanPastPrefix(prefix, fileSize, 8);
  if (count?.state !== "recognized") return count;
  const nlongs = readWord(prefix, 4);
  if (nlongs === undefined) return undefined;
  const nameBytes = admittedNameBytes(nlongs, 0);
  if (nameBytes === undefined) return undefined;
  const nameEnd = 8 + nameBytes;
  if (nameEnd === fileSize) return spanPastPrefix(prefix, fileSize, nameEnd);
  const named = spanPastPrefix(prefix, fileSize, nameEnd + 4);
  if (named?.state !== "recognized") return named;
  const block = readWord(prefix, nameEnd);
  return block !== undefined && OBJECT_BLOCKS.has(block & HUNK_TYPE_MASK)
    ? { state: "recognized" }
    : undefined;
};

const latin1Name = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  const body = end < 0 ? bytes : bytes.subarray(0, end);
  return Buffer.from(body).toString("latin1");
};

interface ResolvedLimits {
  readonly maxHunks: number;
  readonly maxRelocations: number;
  readonly maxRelocationRecords: number;
  readonly maxSymbolBytes: number;
}

const resolveLimits = (
  limits: AmigaHunkLimits | undefined,
): ResolvedLimits => ({
  maxHunks: limits?.maxHunks ?? AMIGA_HUNK_MAX_HUNKS,
  maxRelocations: limits?.maxRelocations ?? AMIGA_HUNK_MAX_RELOCATIONS,
  maxRelocationRecords:
    limits?.maxRelocationRecords ?? AMIGA_HUNK_MAX_RELOCATION_RECORDS,
  maxSymbolBytes: limits?.maxSymbolBytes ?? AMIGA_HUNK_MAX_SYMBOL_BYTES,
});

interface RelocCount {
  kind: AmigaHunkRelocKind;
  targetHunk: number;
  count: number;
}

interface HunkDraft {
  index: number;
  unitIndex: number | null;
  type: AmigaHunkBody | null;
  memory: AmigaHunkMemory;
  extendedFlags: number | null;
  declaredLongwords: number;
  storedLongwords: number | null;
  storedBytes: number | null;
  fileOffset: number | null;
  blockOffset: number;
  name: string | null;
  relocations: Map<string, RelocCount>;
  relocCount: number;
  symbols: AmigaHunkSymbol[];
  debug: boolean;
  debugLongwords: number;
  ended: boolean;
  badTarget: boolean;
  badOffset: boolean;
  missingEnd: boolean;
}

interface UnitDraft {
  index: number;
  name: string;
  offset: number;
}

const draftHunk = (
  index: number,
  memory: AmigaHunkMemory,
  extendedFlags: number | null,
  declaredLongwords: number,
  unitIndex: number | null,
): HunkDraft => ({
  index,
  unitIndex,
  type: null,
  memory,
  extendedFlags,
  declaredLongwords,
  storedLongwords: null,
  storedBytes: null,
  fileOffset: null,
  blockOffset: 0,
  name: null,
  relocations: new Map(),
  relocCount: 0,
  symbols: [],
  debug: false,
  debugLongwords: 0,
  ended: false,
  badTarget: false,
  badOffset: false,
  missingEnd: false,
});

/**
 * Chip, fast, any, or extended from bits 31-30. Both bits set means the
 * next longword is raw memory flags; that read belongs to the parser.
 */
const memoryFromFlags = (flags: number): AmigaHunkMemory => {
  const mem = (flags & HUNK_MEM_MASK) >>> 0;
  if (mem === HUNKF_CHIP) return "chip";
  if (mem === HUNKF_FAST) return "fast";
  if (mem === HUNKF_EXTENDED) return "extended";
  return "any";
};

/**
 * True for an AmigaDOS hunk block id (`HUNK_UNIT` through
 * `HUNK_ABSRELOC16`, except the unassigned id 0x3F4). Padding and other
 * words are not block types.
 */
const isRecognizedHunkBlock = (type: number): boolean =>
  type >= HUNK_UNIT &&
  type <= HUNK_BLOCK_LAST &&
  type !== HUNK_BLOCK_UNASSIGNED;

/**
 * Parse one Hunk image. Structural problems return a partial result.
 * A hunk, relocation or name-byte ceiling throws {@link decodeLimit}.
 * A magic other than `HUNK_HEADER` or `HUNK_UNIT` is malformed.
 */
export const parseAmigaHunk = (
  bytes: Uint8Array,
  limits?: AmigaHunkLimits,
): AmigaHunkFile => {
  if (bytes.length < 4)
    throw truncatedInput(FORMAT, "Amiga Hunk header is shorter than 4 bytes.", {
      offset: 0,
      field: "magic",
    });
  const parser = new AmigaHunkParser(bytes, resolveLimits(limits));
  parser.parse();
  return parser.file();
};

/** Root format metadata for an inventoried Hunk file. */
export const amigaHunkMetadata = (file: AmigaHunkFile): AmigaHunkMetadata => ({
  kind: "amiga-hunk",
  file_kind: file.fileKind,
  resident_libraries: [...file.residentLibraries],
  table_size: file.tableSize,
  first_hunk: file.firstHunk,
  last_hunk: file.lastHunk,
  hunks: file.hunks.map((hunk) => ({
    index: hunk.index,
    unit: hunk.unit,
    type: hunk.type,
    memory: hunk.memory,
    extended_flags: hunk.extendedFlags,
    declared_longwords: hunk.declaredLongwords,
    stored_longwords: hunk.storedLongwords,
    stored_bytes: hunk.storedBytes,
    file_offset: hunk.fileOffset,
    name: hunk.name,
    relocations: hunk.relocations.map((reloc) => ({
      kind: reloc.kind,
      target_hunk: reloc.targetHunk,
      count: reloc.count,
    })),
    symbols: hunk.symbols.map((symbol) => ({
      name: symbol.name,
      offset: symbol.offset,
    })),
    debug: hunk.debug,
    debug_longwords: hunk.debugLongwords,
  })),
  units: file.units.map((unit) => ({
    index: unit.index,
    name: unit.name,
    offset: unit.offset,
  })),
  limitations: file.limitations.map((item) => ({
    kind: item.kind,
    offset: item.offset,
    detail: item.detail,
  })),
});

/** Entry format metadata for one stored code or data hunk from a load file. */
export const amigaHunkEntryMetadata = (
  entry: AmigaHunkEntry,
): AmigaHunkEntryMetadata => ({
  kind: "amiga-hunk-entry",
  hunk: entry.hunk,
  role: entry.role,
  memory: entry.memory,
  declared_bytes: entry.declaredBytes,
  stored_bytes: entry.storedBytes,
});

class AmigaHunkParser {
  private readonly reader: BinaryReader;
  private offset = 0;
  private fileKind: "load" | "object" = "load";
  private readonly libraries: string[] = [];
  private tableSize: number | null = null;
  private firstHunk: number | null = null;
  private lastHunk: number | null = null;
  private readonly hunks: HunkDraft[] = [];
  private readonly units: UnitDraft[] = [];
  private readonly limitations: AmigaHunkLimitation[] = [];
  private readonly entries: AmigaHunkEntry[] = [];
  private symbolBytes = 0;
  private aborted = false;
  private next = 0;
  private unitHunk = 0;
  private open: HunkDraft | undefined;
  private currentUnit: UnitDraft | undefined;
  private pendingName: string | undefined;
  private pendingNameOffset = 0;
  private pendingNameReplaced = false;
  private readonly relocRecords: Budget;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly limits: ResolvedLimits,
  ) {
    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.reader = new BinaryReader(buffer, false, FORMAT);
    this.relocRecords = new Budget(limits.maxRelocationRecords);
  }

  parse(): void {
    const magic = this.u32();
    if (magic === HUNK_HEADER) {
      this.parseLoad();
      return;
    }
    if (magic === HUNK_UNIT) {
      this.fileKind = "object";
      this.offset = 0;
      this.walk();
      return;
    }
    throw malformedInput(
      FORMAT,
      `Amiga Hunk magic 0x${(magic ?? 0).toString(16)} is not HUNK_HEADER or HUNK_UNIT.`,
      { offset: 0, field: "magic" },
    );
  }

  file(): AmigaHunkFile {
    return {
      fileKind: this.fileKind,
      residentLibraries: this.libraries,
      tableSize: this.tableSize,
      firstHunk: this.firstHunk,
      lastHunk: this.lastHunk,
      hunks: this.hunks.map(publishHunk),
      units: this.units.map((unit) => ({
        index: unit.index,
        name: unit.name,
        offset: unit.offset,
      })),
      limitations: this.limitations,
      entries: this.entries,
    };
  }

  private parseLoad(): void {
    if (!this.readLibraries()) return;
    const at = this.offset;
    const tableSize = this.u32();
    const first = this.u32();
    const last = this.u32();
    if (tableSize === undefined || first === undefined || last === undefined) {
      this.failTruncated(at, "hunk header");
      return;
    }
    this.tableSize = tableSize;
    this.firstHunk = first;
    this.lastHunk = last;
    if (first > last) {
      this.note(
        "header",
        at,
        `Hunk header first hunk ${first} is after last hunk ${last}.`,
      );
      return;
    }
    const count = last - first + 1;
    // One size word per hunk is the smallest table this count can occupy.
    // A count whose table cannot fit is a truncated header, not an over-limit
    // file: the hunk ceiling applies only once that table is possible.
    const minimumTableBytes = count * 4;
    const tableFits =
      Number.isSafeInteger(count) &&
      Number.isSafeInteger(minimumTableBytes) &&
      minimumTableBytes <= this.bytes.length - this.offset;
    if (tableFits && count > this.limits.maxHunks)
      throw decodeLimit(
        FORMAT,
        `Amiga Hunk file lists ${count} hunks, above ${this.limits.maxHunks}.`,
        { name: AMIGA_HUNK_HUNK_LIMIT, maximum: this.limits.maxHunks },
      );
    // The table size is the highest hunk number plus one, so the last hunk
    // must index inside it.
    if (last >= tableSize)
      this.note(
        "header",
        at,
        `Hunk header table size ${tableSize} does not cover last hunk ${last}.`,
      );
    if (!this.readSizeTable(first, count)) return;
    this.walk();
  }

  private readLibraries(): boolean {
    while (!this.aborted) {
      const at = this.offset;
      const nlongs = this.u32();
      if (nlongs === undefined) {
        this.failTruncated(at, "resident library list");
        return false;
      }
      if (nlongs === 0) return true;
      const name = this.readName(nlongs);
      if (name === undefined) return false;
      this.libraries.push(name);
    }
    return false;
  }

  private readSizeTable(first: number, count: number): boolean {
    for (let index = 0; index < count; index += 1) {
      if (!this.readSizeWord(first + index)) return false;
    }
    return true;
  }

  /**
   * Bits 31-30 of a header size word or an object block type select
   * memory. Both bits set consume the next longword as raw flags.
   */
  private readMemoryFlags(word: number): DecodedMemoryFlags | undefined {
    const memory = memoryFromFlags(word);
    if (memory !== "extended") return { memory, extendedFlags: null };
    const flagsAt = this.offset;
    const extendedFlags = this.u32();
    if (extendedFlags === undefined) {
      this.failTruncated(flagsAt, "extended memory flags");
      return undefined;
    }
    return { memory, extendedFlags };
  }

  private readSizeWord(index: number): boolean {
    const at = this.offset;
    const word = this.u32();
    if (word === undefined) {
      this.failTruncated(at, "hunk size table");
      return false;
    }
    const decoded = this.readMemoryFlags(word);
    if (decoded === undefined) return false;
    this.hunks.push(
      draftHunk(
        index,
        decoded.memory,
        decoded.extendedFlags,
        word & HUNK_SIZE_MASK,
        null,
      ),
    );
    return true;
  }

  private walk(): void {
    while (!this.aborted && this.offset <= this.bytes.length - 4) {
      if (this.trailingAfterLoadHunks()) break;
      this.dispatchBlock();
    }
    this.finish();
  }

  /**
   * Listed load hunks are closed. Padding, a short remainder, or a word
   * that is not a hunk block id is a tail. A recognized block stays in
   * the walk, so an overlay or a name before another body is named
   * instead of reported as bare trailing bytes.
   */
  private trailingAfterLoadHunks(): boolean {
    if (this.fileKind !== "load" || this.open?.ended !== true) return false;
    if (this.hunks.length === 0 || this.next !== this.hunks.length)
      return false;
    if (!this.fits(4)) return true;
    const type = this.reader.u32(this.offset) & HUNK_TYPE_MASK;
    return !isRecognizedHunkBlock(type);
  }

  private dispatchBlock(): void {
    const blockOffset = this.offset;
    const raw = this.u32();
    if (raw === undefined) return;
    const type = raw & HUNK_TYPE_MASK;
    const flags = raw & ~HUNK_TYPE_MASK;
    if (type === HUNK_UNIT) {
      this.beginUnit(raw, blockOffset);
      return;
    }
    if (type === HUNK_NAME) {
      this.readHunkName(blockOffset);
      return;
    }
    if (type === HUNK_CODE || type === HUNK_DATA || type === HUNK_BSS) {
      this.beginBody(type, flags, blockOffset);
      return;
    }
    if (type === HUNK_RELOC32) {
      this.readLongRelocs(blockOffset, raw, "reloc32");
      return;
    }
    if (type === HUNK_RELOC32SHORT) {
      this.readShortRelocs(blockOffset, raw, "reloc32short");
      return;
    }
    if (type === HUNK_DREL32) {
      if (this.fileKind === "load")
        this.readShortRelocs(blockOffset, raw, "drel32");
      else this.readLongRelocs(blockOffset, raw, "drel32");
      return;
    }
    if (type === HUNK_SYMBOL) {
      this.readSymbols(blockOffset, raw);
      return;
    }
    if (type === HUNK_DEBUG) {
      this.readDebug(blockOffset, raw);
      return;
    }
    if (type === HUNK_END) {
      this.endHunk(blockOffset);
      return;
    }
    this.unknownBlock(raw, blockOffset);
  }

  private beginUnit(raw: number, blockOffset: number): void {
    if (this.fileKind !== "object") {
      this.unknownBlock(raw, blockOffset);
      return;
    }
    if (this.currentUnit !== undefined) {
      const clean = this.open === undefined || this.open.ended;
      if (this.open !== undefined && !this.open.ended)
        this.noteMissingEnd(this.open);
      this.closeUnit(clean ? "clean" : "bounded");
    }
    // A name belongs to the unit that carried it. The next unit's hunk must
    // not inherit a name this boundary did not follow with a body.
    this.retirePendingName();
    this.open = undefined;
    const at = this.offset;
    const nlongs = this.u32();
    if (nlongs === undefined) {
      this.failTruncated(at, "unit name");
      return;
    }
    const name = this.readName(nlongs);
    if (name === undefined) return;
    // An empty unit with an empty name costs no hunk or name allowance, so
    // units share the hunk allowance.
    if (this.units.length >= this.limits.maxHunks)
      throw decodeLimit(
        FORMAT,
        `Amiga Hunk object file lists more than ${this.limits.maxHunks} units.`,
        { name: AMIGA_HUNK_HUNK_LIMIT, maximum: this.limits.maxHunks },
      );
    const unit = { index: this.units.length, name, offset: blockOffset };
    this.units.push(unit);
    this.currentUnit = unit;
    this.unitHunk = 0;
  }

  private beginBody(type: number, flags: number, blockOffset: number): void {
    const kind = bodyKind(type);
    if (this.fileKind === "load") {
      this.beginLoadBody(kind, blockOffset);
      return;
    }
    this.beginObjectBody(kind, flags, blockOffset);
  }

  private beginLoadBody(kind: AmigaHunkBody, blockOffset: number): void {
    if (this.open !== undefined && !this.open.ended)
      this.noteMissingEnd(this.open);
    const hunk = this.hunks[this.next];
    if (hunk === undefined) {
      this.note(
        "header",
        blockOffset,
        `Block at offset ${blockOffset} is past the ${this.hunks.length} hunks the header lists.`,
      );
      this.aborted = true;
      return;
    }
    this.next += 1;
    this.openHunk(hunk, blockOffset);
    this.readBody(hunk, kind);
  }

  private beginObjectBody(
    kind: AmigaHunkBody,
    flags: number,
    blockOffset: number,
  ): void {
    if (this.currentUnit === undefined) {
      this.note(
        "missing-body",
        blockOffset,
        `Hunk block 0x${kind === "data" ? HUNK_DATA.toString(16) : kind === "bss" ? HUNK_BSS.toString(16) : HUNK_CODE.toString(16)} at offset ${blockOffset} is outside a unit.`,
      );
      this.aborted = true;
      return;
    }
    if (this.hunks.length >= this.limits.maxHunks)
      throw decodeLimit(
        FORMAT,
        `Amiga Hunk file lists more than ${this.limits.maxHunks} hunks.`,
        { name: AMIGA_HUNK_HUNK_LIMIT, maximum: this.limits.maxHunks },
      );
    const decoded = this.readMemoryFlags(flags);
    if (decoded === undefined) return;
    if (this.open !== undefined && !this.open.ended)
      this.noteMissingEnd(this.open);
    const hunk = draftHunk(
      this.unitHunk,
      decoded.memory,
      decoded.extendedFlags,
      0,
      this.currentUnit.index,
    );
    this.unitHunk += 1;
    this.hunks.push(hunk);
    this.openHunk(hunk, blockOffset);
    this.readBody(hunk, kind);
  }

  private openHunk(hunk: HunkDraft, blockOffset: number): void {
    hunk.blockOffset = blockOffset;
    hunk.ended = false;
    if (this.pendingName !== undefined) {
      hunk.name = this.pendingName;
      this.pendingName = undefined;
      this.pendingNameReplaced = false;
    }
    this.open = hunk;
  }

  private readBody(hunk: HunkDraft, kind: AmigaHunkBody): void {
    hunk.type = kind;
    const at = this.offset;
    const nlongs = this.u32();
    if (nlongs === undefined) {
      this.failTruncated(at, "hunk size");
      return;
    }
    // A load-file header may allocate more than the block stores; the loader
    // zero-fills the tail. Only a block larger than its allocation conflicts.
    if (this.fileKind === "object") hunk.declaredLongwords = nlongs;
    else if (nlongs > hunk.declaredLongwords)
      this.note(
        "size-mismatch",
        hunk.blockOffset,
        `Hunk ${hunk.index} header allocates ${hunk.declaredLongwords} longwords and the block stores ${nlongs}.`,
      );
    if (kind === "bss") {
      hunk.storedLongwords = nlongs;
      return;
    }
    const byteLength = nlongs * 4;
    if (!this.fits(byteLength)) {
      this.failTruncated(at, "hunk bytes");
      return;
    }
    hunk.storedLongwords = nlongs;
    hunk.storedBytes = byteLength;
    hunk.fileOffset = this.offset;
    this.offset += byteLength;
    if (this.fileKind === "load") this.addLoadEntry(hunk);
  }

  private addLoadEntry(hunk: HunkDraft): void {
    if (hunk.type !== "code" && hunk.type !== "data") return;
    if (hunk.storedBytes === null || hunk.fileOffset === null) return;
    this.entries.push({
      path: `hunk-${hunk.index}-${hunk.type}.bin`,
      role: hunk.type,
      hunk: hunk.index,
      memory: hunk.memory,
      declaredBytes: hunk.declaredLongwords * 4,
      storedBytes: hunk.storedBytes,
      byteOffset: hunk.fileOffset,
    });
  }

  private readLongRelocs(
    blockOffset: number,
    raw: number,
    kind: AmigaHunkRelocKind,
  ): void {
    const hunk = this.requireBody(blockOffset, raw);
    if (hunk === undefined) return;
    while (!this.aborted) {
      const at = this.offset;
      const count = this.u32();
      if (count === undefined) {
        this.failTruncated(at, "relocation table");
        return;
      }
      if (count === 0) return;
      if (!this.fits((count + 1) * 4)) {
        this.failTruncated(at, "relocation table");
        return;
      }
      this.chargeRelocs(hunk, count);
      if (!this.readRelocGroup(hunk, kind, count, 4)) return;
    }
  }

  private readShortRelocs(
    blockOffset: number,
    raw: number,
    kind: AmigaHunkRelocKind,
  ): void {
    const hunk = this.requireBody(blockOffset, raw);
    if (hunk === undefined) return;
    while (!this.aborted) {
      const at = this.offset;
      const count = this.u16();
      if (count === undefined) {
        this.failTruncated(at, "short relocation table");
        return;
      }
      if (count === 0) {
        this.align4();
        return;
      }
      if (!this.fits((count + 1) * 2)) {
        this.failTruncated(at, "short relocation table");
        return;
      }
      this.chargeRelocs(hunk, count);
      if (!this.readRelocGroup(hunk, kind, count, 2)) return;
    }
  }

  private readRelocGroup(
    hunk: HunkDraft,
    kind: AmigaHunkRelocKind,
    count: number,
    width: 2 | 4,
  ): boolean {
    const at = this.offset;
    const target = width === 4 ? this.u32() : this.u16();
    if (target === undefined) {
      this.failTruncated(at, "relocation target");
      return false;
    }
    const size = hunk.declaredLongwords * 4;
    let badOffset = false;
    for (let index = 0; index < count; index += 1) {
      const offAt = this.offset;
      const off = width === 4 ? this.u32() : this.u16();
      if (off === undefined) {
        this.failTruncated(offAt, "relocation offset");
        return false;
      }
      if (size < 4 || off > size - 4) badOffset = true;
    }
    this.addReloc(hunk, kind, target, count);
    this.noteRelocTarget(hunk, target);
    if (badOffset) this.noteRelocOffset(hunk, size);
    return true;
  }

  private chargeRelocs(hunk: HunkDraft, count: number): void {
    if (count > this.limits.maxRelocations - hunk.relocCount)
      throw decodeLimit(
        FORMAT,
        `Amiga Hunk relocations in hunk ${hunk.index} exceed ${this.limits.maxRelocations}.`,
        {
          name: AMIGA_HUNK_RELOCATION_LIMIT,
          maximum: this.limits.maxRelocations,
        },
      );
    hunk.relocCount += count;
  }

  private addReloc(
    hunk: HunkDraft,
    kind: AmigaHunkRelocKind,
    target: number,
    count: number,
  ): void {
    const key = `${kind}:${target}`;
    const existing = hunk.relocations.get(key);
    if (existing !== undefined) {
      existing.count += count;
      return;
    }
    // Each distinct kind and target is a retained record. The per-hunk
    // relocation count does not bound records across the file.
    this.relocRecords.charge(1, () =>
      decodeLimit(
        FORMAT,
        `Amiga Hunk relocation records across the file exceed ${this.limits.maxRelocationRecords}.`,
        {
          name: AMIGA_HUNK_RELOCATION_RECORD_LIMIT,
          maximum: this.limits.maxRelocationRecords,
        },
      ),
    );
    hunk.relocations.set(key, { kind, targetHunk: target, count });
  }

  private noteRelocTarget(hunk: HunkDraft, target: number): void {
    if (this.fileKind !== "load" || hunk.badTarget) return;
    const first = this.firstHunk;
    const last = this.lastHunk;
    if (first !== null && last !== null && target >= first && target <= last)
      return;
    hunk.badTarget = true;
    this.note(
      "relocation-target",
      hunk.blockOffset,
      `Hunk ${hunk.index} has a relocation targeting hunk ${target}, which is outside hunks ${first ?? 0} through ${last ?? 0}.`,
    );
  }

  private noteRelocOffset(hunk: HunkDraft, size: number): void {
    if (hunk.badOffset) return;
    hunk.badOffset = true;
    this.note(
      "relocation-offset",
      hunk.blockOffset,
      `Hunk ${hunk.index} has a relocation past its ${size}-byte size.`,
    );
  }

  private readSymbols(blockOffset: number, raw: number): void {
    const hunk = this.requireBody(blockOffset, raw);
    if (hunk === undefined) return;
    while (!this.aborted) {
      const at = this.offset;
      const nlongs = this.u32();
      if (nlongs === undefined) {
        this.failTruncated(at, "symbol table");
        return;
      }
      if (nlongs === 0) return;
      const name = this.readName(nlongs);
      if (name === undefined) return;
      const valueAt = this.offset;
      const value = this.u32();
      if (value === undefined) {
        this.failTruncated(valueAt, "symbol offset");
        return;
      }
      hunk.symbols.push({ name, offset: value });
    }
  }

  private readDebug(blockOffset: number, raw: number): void {
    const hunk = this.requireBody(blockOffset, raw);
    if (hunk === undefined) return;
    const at = this.offset;
    const nlongs = this.u32();
    if (nlongs === undefined) {
      this.failTruncated(at, "debug hunk");
      return;
    }
    const byteLength = nlongs * 4;
    if (!this.fits(byteLength)) {
      this.failTruncated(at, "debug hunk");
      return;
    }
    this.offset += byteLength;
    hunk.debug = true;
    hunk.debugLongwords += nlongs;
  }

  private readHunkName(blockOffset: number): void {
    const at = this.offset;
    const nlongs = this.u32();
    if (nlongs === undefined) {
      this.failTruncated(at, "hunk name");
      return;
    }
    const name = this.readName(nlongs);
    if (name === undefined) return;
    // One record per run of replaced names keeps limitations bounded by the
    // hunk allowance; a run of empty HUNK_NAME blocks costs no name bytes.
    if (this.pendingName !== undefined && !this.pendingNameReplaced) {
      this.pendingNameReplaced = true;
      this.note(
        "header",
        blockOffset,
        `Hunk name at offset ${blockOffset} replaces a name that was not followed by a hunk.`,
      );
    }
    this.pendingName = name;
    this.pendingNameOffset = blockOffset;
  }

  private endHunk(blockOffset: number): void {
    if (this.open === undefined || this.open.ended) {
      this.note(
        "missing-end",
        blockOffset,
        `HUNK_END at offset ${blockOffset} has no open hunk.`,
      );
      this.aborted = true;
      return;
    }
    this.open.ended = true;
  }

  private requireBody(blockOffset: number, raw: number): HunkDraft | undefined {
    if (this.open !== undefined && this.open.type !== null && !this.open.ended)
      return this.open;
    const type = raw & HUNK_TYPE_MASK;
    this.note(
      "missing-body",
      blockOffset,
      `Hunk block 0x${type.toString(16)} at offset ${blockOffset} has no open hunk.`,
    );
    this.aborted = true;
    return undefined;
  }

  private unknownBlock(raw: number, blockOffset: number): void {
    const type = raw & HUNK_TYPE_MASK;
    const flags = raw & ~HUNK_TYPE_MASK;
    const advisory =
      flags !== 0
        ? ` (block word 0x${(raw >>> 0).toString(16)}${(raw & HUNKF_ADVISORY) !== 0 ? ", advisory bit set" : ""})`
        : "";
    this.note(
      "unknown-block",
      blockOffset,
      `Unknown hunk block 0x${type.toString(16)} at offset ${blockOffset}${advisory}.`,
    );
    // Bytes after an unsupported block were not examined, so a later
    // HUNK_END is unknown rather than absent.
    this.aborted = true;
  }

  private retirePendingName(): void {
    if (this.pendingName === undefined) return;
    this.note(
      "header",
      this.pendingNameOffset,
      "A hunk name was not followed by a hunk.",
    );
    this.pendingName = undefined;
    this.pendingNameReplaced = false;
  }

  private finish(): void {
    if (!this.aborted) this.retirePendingName();
    if (!this.aborted && this.open !== undefined && !this.open.ended)
      this.noteMissingEnd(this.open);
    if (
      !this.aborted &&
      this.fileKind === "load" &&
      this.next < this.hunks.length
    )
      this.note(
        "header",
        this.offset,
        `The header lists ${this.hunks.length} hunks and the file ends after ${this.next}.`,
      );
    if (!this.aborted && this.fileKind === "object") this.closeUnit("clean");
    if (!this.aborted && this.offset < this.bytes.length)
      this.note(
        "trailing-bytes",
        this.offset,
        `Trailing ${this.bytes.length - this.offset} bytes at offset ${this.offset} follow the last hunk.`,
      );
  }

  private closeUnit(mode: "clean" | "bounded"): void {
    const unit = this.currentUnit;
    if (unit === undefined) return;
    this.currentUnit = undefined;
    if (mode === "clean" && this.open !== undefined && !this.open.ended) return;
    if (mode === "clean") this.checkObjectTargets(unit.index);
  }

  private checkObjectTargets(unitIndex: number): void {
    const hunks = this.hunks.filter((hunk) => hunk.unitIndex === unitIndex);
    const seen = new Set(hunks.map((hunk) => hunk.index));
    for (const hunk of hunks) {
      for (const reloc of hunk.relocations.values()) {
        if (seen.has(reloc.targetHunk) || hunk.badTarget) continue;
        hunk.badTarget = true;
        this.note(
          "relocation-target",
          hunk.blockOffset,
          `Hunk ${hunk.index} has a relocation targeting hunk ${reloc.targetHunk}, which this unit does not list.`,
        );
      }
    }
  }

  private noteMissingEnd(hunk: HunkDraft): void {
    if (hunk.missingEnd) return;
    hunk.missingEnd = true;
    this.note(
      "missing-end",
      hunk.blockOffset,
      `Hunk ${hunk.index} has no HUNK_END.`,
    );
  }

  private readName(nlongs: number): string | undefined {
    const byteLength = nlongs * 4;
    if (!this.fits(byteLength)) {
      this.failTruncated(this.offset, "name");
      return undefined;
    }
    if (byteLength > this.limits.maxSymbolBytes - this.symbolBytes)
      throw decodeLimit(
        FORMAT,
        `Amiga Hunk name of ${byteLength} bytes exceeds the ${this.limits.maxSymbolBytes}-byte name allowance (${this.symbolBytes} bytes already retained).`,
        { name: AMIGA_HUNK_SYMBOL_LIMIT, maximum: this.limits.maxSymbolBytes },
      );
    const slice = this.bytes.subarray(this.offset, this.offset + byteLength);
    this.offset += byteLength;
    this.symbolBytes += byteLength;
    return latin1Name(slice);
  }

  private align4(): boolean {
    const pad = (4 - (this.offset % 4)) % 4;
    if (pad === 0) return true;
    if (!this.fits(pad)) {
      this.failTruncated(this.offset, "relocation padding");
      return false;
    }
    this.offset += pad;
    return true;
  }

  private fits(byteLength: number): boolean {
    return byteLength <= this.bytes.length - this.offset;
  }

  private u32(): number | undefined {
    if (!this.fits(4)) return undefined;
    const value = this.reader.u32(this.offset);
    this.offset += 4;
    return value;
  }

  private u16(): number | undefined {
    if (!this.fits(2)) return undefined;
    const value = this.reader.u16(this.offset);
    this.offset += 2;
    return value;
  }

  private failTruncated(at: number, what: string): void {
    this.note("truncated", at, `Truncated Amiga Hunk ${what} at offset ${at}.`);
    this.aborted = true;
  }

  private note(
    kind: AmigaHunkLimitationKind,
    offset: number,
    detail: string,
  ): void {
    this.limitations.push({ kind, offset, detail });
  }
}

const bodyKind = (type: number): AmigaHunkBody => {
  if (type === HUNK_DATA) return "data";
  if (type === HUNK_BSS) return "bss";
  return "code";
};

const publishHunk = (hunk: HunkDraft): AmigaHunk => ({
  index: hunk.index,
  unit: hunk.unitIndex,
  type: hunk.type,
  memory: hunk.memory,
  extendedFlags: hunk.extendedFlags,
  declaredLongwords: hunk.declaredLongwords,
  storedLongwords: hunk.storedLongwords,
  storedBytes: hunk.storedBytes,
  fileOffset: hunk.fileOffset,
  name: hunk.name,
  relocations: [...hunk.relocations.values()],
  symbols: hunk.symbols,
  debug: hunk.debug,
  debugLongwords: hunk.debugLongwords,
});
