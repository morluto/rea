import { readInitializerWord } from "./initializerWord.js";
import { setImmediate as immediate } from "node:timers/promises";
import {
  assertArtifactReadActive,
  yieldArtifactRead,
} from "../../resources/index.js";
import {
  joinCoverageStatus,
  type CoverageStatus,
} from "../../domain/coverage.js";
import {
  admitElfDynamicDirectory,
  readElfDynamicEntry,
} from "../../domain/elfDynamicEntry.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import {
  MAX_NATIVE_INITIALIZER_ENTRIES,
  MAX_NATIVE_INITIALIZER_NAME_BYTES,
  type NativeInitializerInspection,
  type NativeInitializerKind,
} from "../../domain/native/nativeInitializers.js";
import type { ElfPointerWrite } from "../../domain/native/elfPointerRelocations.js";
import {
  ElfPointerRelocationFailure,
  elfRelativeRelocationType,
  readElfRelocationWritesSteps,
} from "../../domain/native/elfPointerRelocations.js";
import {
  readElfImage,
  readElfImageFromDirectory,
} from "../../domain/native/elfImage.js";
import {
  BinaryFormatFailure,
  BinaryMappingFailure,
  BinaryReader,
  BinaryResourceFailure,
  createFileMappingIndex,
  type ElfDynamicSegment,
  type FileMappingIndex,
} from "../../domain/binaryContainer.js";
import {
  readElfDirectoryFromBuffer,
  readElfDirectoryFromBufferCooperative,
} from "../../domain/native/nativeSectionDirectory.js";
import type { NativeSection } from "../../domain/native/nativeSectionDirectory.js";
import {
  loadElfSymbolIndex,
  elfInitializerSlotKey,
  relocationFromEntry,
  sectionRelocations,
  sectionSymbolKey,
  type ElfInitializerSymbol,
  type ElfSymbolIndex,
  type SlotRelocation,
  type ElfInitializerSlot,
} from "./ElfInitializerSymbols.js";
import {
  finishInitializerReport,
  preferInitializerSymbolName,
  type InitializerSymbolName,
  type CollectedInitializer,
  type InitializerPage,
} from "./initializerReport.js";
import { InitializerNotes } from "./initializerNotes.js";
import { buildAddressRangeIndex } from "./addressRangeIndex.js";

const DT_SYMTAB = 6n;
const DT_INIT = 12n;
const DT_FINI = 13n;
const DT_INIT_ARRAY = 25n;
const DT_FINI_ARRAY = 26n;
const DT_INIT_ARRAYSZ = 27n;
const DT_FINI_ARRAYSZ = 28n;
const DT_PREINIT_ARRAY = 32n;
const DT_PREINIT_ARRAYSZ = 33n;
/**
 * The dynamic tags this inspection reads. Others, such as DT_NEEDED, repeat by
 * design and are not tracked, so their repetition is not a duplicate.
 */
const CONSUMED_DYNAMIC_TAGS: ReadonlySet<bigint> = new Set([
  DT_SYMTAB,
  DT_INIT,
  DT_FINI,
  DT_INIT_ARRAY,
  DT_FINI_ARRAY,
  DT_INIT_ARRAYSZ,
  DT_FINI_ARRAYSZ,
  DT_PREINIT_ARRAY,
  DT_PREINIT_ARRAYSZ,
]);
const SHT_INIT_ARRAY = 14;
const SHT_FINI_ARRAY = 15;
const SHT_PREINIT_ARRAY = 16;
const ET_REL = 1;
const EM_ARM = 40;

interface DynTag {
  readonly value: bigint;
  readonly valueOffset: number;
  readonly valueAddress: bigint;
}

interface ArraySlot extends ElfInitializerSlot {
  readonly mappingMismatch?: boolean;
  readonly va: bigint;
  readonly fileOffset: number | null;
  readonly sectionName: string | null;
  readonly direct?: undefined;
}

/** DT_INIT / DT_FINI: the dynamic entry's value field holds the target itself. */
interface DirectSlot {
  /** Null when the value field is outside every load segment. */
  readonly va: bigint | null;
  readonly fileOffset: number;
  readonly sectionName: string | null;
  /** The link-time address stored in the dynamic entry. */
  readonly direct: bigint;
}

type Slot = ArraySlot | DirectSlot;

interface Source {
  readonly kind: NativeInitializerKind;
  readonly sentinel: boolean;
  readonly detail: string;
  readonly slots: readonly Slot[];
}

interface ElfScan {
  readonly reader: BinaryReader;
  readonly bytes: Buffer;
  readonly bits: 32 | 64;
  readonly little: boolean;
  readonly machine: number;
  readonly relocatable: boolean;
  readonly notes: InitializerNotes;
  /** Known gaps (`partial`) and undetermined facts (`unknown`) noted so far. */
  coverage: CoverageStatus;
  /** Array slots still walkable across every source, so a declared size never sets the work. */
  slotBudget: number;
}

/**
 * Record an observation and its effect on coverage: `partial` when declared
 * slots or names were examined but not reported, `unknown` when whether the
 * listed facts are complete cannot be determined, `complete` for a note that
 * loses nothing.
 */
const note = (scan: ElfScan, message: string, effect: CoverageStatus): void => {
  scan.notes.add(message);
  scan.coverage = joinCoverageStatus([scan.coverage, effect]);
};

const wordOf = (bits: 32 | 64): number => bits / 8;

/** `.ctors` / `.dtors` sentinels: 0 and all-ones at the image's pointer width. */
const isSentinel = (value: bigint, bits: 32 | 64): boolean =>
  value === 0n || value === (1n << BigInt(bits)) - 1n;

/** Read the consumed DT_* tags. The first duplicate wins. A missing DT_NULL leaves coverage unknown. */
const readDynamicTags = (
  scan: ElfScan,
  segment: ElfDynamicSegment | undefined,
  extra: number,
): Map<bigint, DynTag> => {
  const tags = new Map<bigint, DynTag>();
  if (segment === undefined) return tags;
  if (extra > 0)
    throw new BinaryFormatFailure("malformed", "multiple PT_DYNAMIC segments");
  const table = admitElfDynamicDirectory(scan.bytes.length, segment, scan.bits);
  if (!table.ok) {
    if (table.error.kind === "malformed")
      throw new BinaryFormatFailure("malformed", table.error.message);
    throw new BinaryResourceFailure(
      "structure",
      table.error.maximum,
      table.error.message,
      "structure",
      "bytes",
    );
  }
  const { offset: start, size, width } = table.value;
  let terminated = false;
  for (let at = start; at + width <= start + size; at += width) {
    const parsed = readElfDynamicEntry(
      scan.bytes.subarray(at, at + width),
      scan.bits,
      scan.little,
    );
    if (!parsed.ok)
      throw new BinaryFormatFailure("malformed", parsed.error.message);
    if (parsed.value.tag === 0n) {
      terminated = true;
      break;
    }
    if (!CONSUMED_DYNAMIC_TAGS.has(parsed.value.tag)) continue;
    if (tags.has(parsed.value.tag)) {
      note(
        scan,
        `Duplicate dynamic tag ${parsed.value.tag} was ignored after the first value.`,
        "unknown",
      );
      continue;
    }
    const valueOffset = at + wordOf(scan.bits);
    tags.set(parsed.value.tag, {
      value: parsed.value.value,
      valueOffset,
      valueAddress: segment.virtual_address + BigInt(valueOffset - start),
    });
  }
  if (!terminated)
    note(
      scan,
      "PT_DYNAMIC has no DT_NULL terminator. Tags seen before the end were used.",
      "unknown",
    );
  return tags;
};

/**
 * File offset of `size` bytes at `address`: a whole slot, or a target's first
 * byte. Only load mappings establish linked addresses: section declarations
 * cannot supply backing for an unmapped or zero-filled address. Ambiguous
 * mappings stay unknown and leave coverage unknown.
 */
const fileOffsetFor = (
  scan: ElfScan,
  mappings: FileMappingIndex,
  address: bigint,
  size: number,
): number | null => {
  try {
    return mappings.offset(address, size);
  } catch (cause) {
    if (!(cause instanceof BinaryMappingFailure)) throw cause;
    if (cause.reason === "ambiguous") note(scan, AMBIGUOUS_MAPPING, "unknown");
    return null;
  }
};

const AMBIGUOUS_MAPPING =
  "An address has ambiguous file mappings (overlapping load segments with different file offsets, or file and zero-fill memory), so its file offset is not reported.";

interface ElfSectionIndex {
  /** Name of the smallest SHF_ALLOC section containing `address`; earlier headers win ties. */
  readonly nameAt: (address: bigint) => string | null;
}

interface ClassifiedSections {
  readonly index: ElfSectionIndex;
  readonly byKind: Readonly<
    Record<
      "preinit_array" | "init_array" | "fini_array" | "ctors" | "dtors",
      readonly NativeSection[]
    >
  >;
}

const classifySections = (
  sections: readonly NativeSection[],
  namesKnown: boolean,
): ClassifiedSections => {
  const allocRanges: {
    readonly start: bigint;
    readonly end: bigint;
    readonly value: NativeSection;
  }[] = [];
  const preinit_array: NativeSection[] = [];
  const init_array: NativeSection[] = [];
  const fini_array: NativeSection[] = [];
  const ctors: NativeSection[] = [];
  const dtors: NativeSection[] = [];
  for (const section of sections) {
    if (section.size !== 0n && (section.flags & 2n) !== 0n) {
      allocRanges.push({
        start: section.address,
        end: section.address + section.size,
        value: section,
      });
    }
    if (
      section.type === SHT_PREINIT_ARRAY ||
      (namesKnown && matchesName(section, ".preinit_array"))
    )
      preinit_array.push(section);
    if (
      section.type === SHT_INIT_ARRAY ||
      (namesKnown && matchesName(section, ".init_array"))
    )
      init_array.push(section);
    if (
      section.type === SHT_FINI_ARRAY ||
      (namesKnown && matchesName(section, ".fini_array"))
    )
      fini_array.push(section);
    if (namesKnown && matchesName(section, ".ctors")) ctors.push(section);
    if (namesKnown && matchesName(section, ".dtors")) dtors.push(section);
  }
  const named = buildAddressRangeIndex(allocRanges, (left, right) =>
    left.size < right.size
      ? -1
      : left.size > right.size
        ? 1
        : left.index - right.index,
  );
  return {
    index: {
      nameAt(address) {
        const name = named.at(address)?.value.name;
        return name == null || name.length === 0 ? null : name;
      },
    },
    byKind: { preinit_array, init_array, fini_array, ctors, dtors },
  };
};

const slotsFromSpan = (
  scan: ElfScan,
  base: bigint,
  byteSize: bigint,
  label: string,
  locate: (address: bigint) => number | null,
  sectionName: string | null,
  sectionIndex: number | null = null,
): ArraySlot[] => {
  const stride = BigInt(wordOf(scan.bits));
  if (byteSize < 0n || byteSize % stride !== 0n)
    note(
      scan,
      byteSize < 0n
        ? `${label} size is negative.`
        : `${label} size is not a multiple of the pointer width. Trailing bytes were not read.`,
      "partial",
    );
  if (byteSize < 0n) return [];
  const declared = byteSize / stride;
  const budget = BigInt(scan.slotBudget);
  const count = Number(declared < budget ? declared : budget);
  scan.slotBudget -= count;
  if (declared > budget)
    note(
      scan,
      `${label} declares ${declared.toString()} slots. Scanning stopped at the ${String(MAX_NATIVE_INITIALIZER_ENTRIES)}-slot budget, so later slots were not read.`,
      "partial",
    );
  const slots: ArraySlot[] = [];
  let missed = false;
  for (let index = 0; index < count; index += 1) {
    const va = base + BigInt(index) * stride;
    const fileOffset = locate(va);
    if (fileOffset === null) {
      missed = true;
      continue;
    }
    slots.push({ va, fileOffset, sectionName, sectionIndex });
  }
  if (missed)
    note(
      scan,
      `${label} has slots that are not file-backed. Those slots were omitted.`,
      "partial",
    );
  return slots;
};

/** Output sections, plus `.name.*` input sections in relocatable objects. */
const matchesName = (section: NativeSection, name: string): boolean =>
  section.name === name || (section.name?.startsWith(`${name}.`) ?? false);

/** File offset of an address inside one file-backed section. */
const withinSection =
  (section: NativeSection, width: number) =>
  (address: bigint): number | null => {
    if (!section.file_backed || section.compressed || address < section.address)
      return null;
    const delta = address - section.address;
    if (delta + BigInt(width) > section.size) return null;
    return Number(section.offset + delta);
  };

const sectionSource = (
  scan: ElfScan,
  section: NativeSection,
  kind: NativeInitializerKind,
  sentinel: boolean,
  fallbackName: string,
): Source => {
  // An over-long section name would flood limitations, so the request name labels it.
  const label =
    section.name !== null &&
    section.name.length > 0 &&
    section.name.length <= MAX_NATIVE_INITIALIZER_NAME_BYTES
      ? section.name
      : fallbackName;
  if (section.compressed) {
    note(
      scan,
      `${label} is compressed. Its initializer slots were not decoded.`,
      "partial",
    );
    return { kind, sentinel, detail: label, slots: [] };
  }
  if (!section.file_backed) {
    note(
      scan,
      `${label} is not file-backed. Its slots were omitted.`,
      "partial",
    );
    return { kind, sentinel, detail: label, slots: [] };
  }
  return {
    kind,
    sentinel,
    detail: label,
    slots: slotsFromSpan(
      scan,
      section.address,
      section.size,
      label,
      withinSection(section, wordOf(scan.bits)),
      section.name,
      section.index,
    ),
  };
};

interface ArrayRequest {
  readonly kind: "preinit_array" | "init_array" | "fini_array";
  readonly addressTag: bigint;
  readonly sizeTag: bigint;
  readonly sectionName: string;
  readonly detail: string;
}

/** DT_* array when declared, otherwise every matching section in header order. */
const arraySources = (
  scan: ElfScan,
  tags: ReadonlyMap<bigint, DynTag>,
  classified: ClassifiedSections,
  request: ArrayRequest,
  locate: (address: bigint) => number | null,
): Source[] => {
  const address = tags.get(request.addressTag);
  if (address === undefined)
    return classified.byKind[request.kind].map((section) =>
      sectionSource(scan, section, request.kind, false, request.sectionName),
    );
  const size = tags.get(request.sizeTag);
  if (size === undefined) {
    note(
      scan,
      `${request.detail} has no size tag. Its slots were not read.`,
      "partial",
    );
    return [];
  }
  return [
    {
      kind: request.kind,
      sentinel: false,
      detail: request.detail,
      slots: slotsFromSpan(
        scan,
        address.value,
        size.value,
        request.detail,
        locate,
        classified.index.nameAt(address.value),
      ),
    },
  ];
};

const legacySources = (
  scan: ElfScan,
  classified: ClassifiedSections,
  name: ".ctors" | ".dtors",
  kind: "ctors" | "dtors",
): Source[] =>
  classified.byKind[kind].map((section) =>
    sectionSource(scan, section, kind, true, name),
  );

const directSource = (
  scan: ElfScan,
  tags: ReadonlyMap<bigint, DynTag>,
  index: ElfSectionIndex,
  locate: (address: bigint) => number | null,
  tag: bigint,
  kind: NativeInitializerKind,
  detail: string,
): Source | null => {
  const entry = tags.get(tag);
  if (entry === undefined) return null;
  const va =
    locate(entry.valueAddress) === entry.valueOffset
      ? entry.valueAddress
      : null;
  // The actual file field still supplies the value even when its declared virtual slot is unproven.
  if (va === null)
    note(
      scan,
      `${detail} value field is not fully file-backed at its declared PT_DYNAMIC address.`,
      "unknown",
    );
  return {
    kind,
    sentinel: false,
    detail,
    slots: [
      {
        va,
        fileOffset: entry.valueOffset,
        sectionName: va === null ? null : index.nameAt(va),
        direct: entry.value,
      },
    ],
  };
};

const ARRAYS: readonly ArrayRequest[] = [
  {
    kind: "preinit_array",
    addressTag: DT_PREINIT_ARRAY,
    sizeTag: DT_PREINIT_ARRAYSZ,
    sectionName: ".preinit_array",
    detail: "DT_PREINIT_ARRAY",
  },
  {
    kind: "init_array",
    addressTag: DT_INIT_ARRAY,
    sizeTag: DT_INIT_ARRAYSZ,
    sectionName: ".init_array",
    detail: "DT_INIT_ARRAY",
  },
  {
    kind: "fini_array",
    addressTag: DT_FINI_ARRAY,
    sizeTag: DT_FINI_ARRAYSZ,
    sectionName: ".fini_array",
    detail: "DT_FINI_ARRAY",
  },
];

const collectSources = (
  scan: ElfScan,
  tags: ReadonlyMap<bigint, DynTag>,
  classified: ClassifiedSections,
  locate: (address: bigint) => number | null,
): Source[] => {
  const [preinit, initArray, finiArray] = ARRAYS.map((request) =>
    arraySources(scan, tags, classified, request, locate),
  );
  const init = directSource(
    scan,
    tags,
    classified.index,
    locate,
    DT_INIT,
    "init",
    "DT_INIT",
  );
  const fini = directSource(
    scan,
    tags,
    classified.index,
    locate,
    DT_FINI,
    "fini",
    "DT_FINI",
  );
  return [
    ...(preinit ?? []),
    ...(init === null ? [] : [init]),
    ...(initArray ?? []),
    ...legacySources(scan, classified, ".ctors", "ctors"),
    ...(fini === null ? [] : [fini]),
    ...(finiArray ?? []),
    ...legacySources(scan, classified, ".dtors", "dtors"),
  ];
};

interface WriteLoad {
  /** Exactly one full-width write starts at each slot here, with nothing else overlapping it. */
  readonly writes: ReadonlyMap<bigint, ElfPointerWrite>;
  /** Slots that a narrower, offset or conflicting write overlaps; their value is unknown. */
  readonly clobbered: ReadonlySet<bigint>;
  readonly trustRaw: boolean;
}

/**
 * Index of the first slot whose word could overlap a write starting at
 * `address`, that is the first slot above `address - word`.
 */
const firstOverlap = (
  slots: readonly bigint[],
  address: bigint,
  word: number,
): number => {
  const from = address - BigInt(word);
  let low = 0;
  let high = slots.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((slots[mid] ?? address) <= from) low = mid + 1;
    else high = mid;
  }
  return low;
};

/**
 * Drain the shared dynamic-relocation reader, keeping only writes that touch a
 * wanted slot. A slot is resolved by a write only when that write starts at the
 * slot with the pointer width and no other write overlaps the slot, which
 * matches the shared overlay's `pointerAt` rule without retaining every write.
 * The reader pauses at the generator's own yield points so a large table does
 * not block the event loop, and observes cancellation there.
 */
const loadWrites = async (
  scan: ElfScan,
  image: ReturnType<typeof readElfImage>,
  wanted: ReadonlySet<bigint>,
  signal: AbortSignal | undefined,
): Promise<WriteLoad> => {
  if (wanted.size === 0 || image.elf.dynamicSegments.length === 0)
    return { writes: new Map(), clobbered: new Set(), trustRaw: true };
  const word = wordOf(scan.bits);
  const slots = [...wanted].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const writes = new Map<bigint, ElfPointerWrite>();
  const clobbered = new Set<bigint>();
  const consider = (write: ElfPointerWrite): void => {
    const end = write.address + BigInt(write.width);
    for (
      let at = firstOverlap(slots, write.address, word);
      at < slots.length;
      at += 1
    ) {
      const slot = slots[at];
      if (slot === undefined || slot >= end) break;
      if (clobbered.has(slot)) continue;
      const exact = slot === write.address && write.width === word;
      const previous = writes.get(slot);
      if (exact && previous === undefined) {
        writes.set(slot, write);
        continue;
      }
      writes.delete(slot);
      clobbered.add(slot);
    }
  };
  try {
    const steps = readElfRelocationWritesSteps(
      scan.bytes,
      {
        bits: scan.bits,
        little: scan.little,
        machine: scan.machine,
        dynamicSegments: image.elf.dynamicSegments,
        mappings: image.mappings,
        zeroFills: image.zero_fills,
      },
      { unsupported: "record", wholeExtents: true },
    );
    let next = steps.next();
    while (!next.done) {
      if (next.value === undefined) {
        await immediate();
        assertArtifactReadActive(signal);
      } else consider(next.value);
      next = steps.next();
    }
    if (clobbered.size > 0)
      note(
        scan,
        `${String(clobbered.size)} initializer slot(s) are partly overwritten or written more than once by dynamic relocations and are listed as unresolved.`,
        "unknown",
      );
    if (!next.value.pointer_coverage_known) {
      const issues = next.value.issues;
      if (issues.length === 0)
        note(scan, "Dynamic relocation coverage is incomplete.", "unknown");
      for (const issue of issues) note(scan, issue, "unknown");
      return { writes, clobbered, trustRaw: false };
    }
    return { writes, clobbered, trustRaw: true };
  } catch (cause) {
    // A budget stop is not a malformed table; the provider reports it with
    // the maximum the failing index declared.
    if (
      !(cause instanceof ElfPointerRelocationFailure) ||
      cause.kind === "limit"
    )
      throw cause;
    note(scan, cause.message, "unknown");
    return { writes: new Map(), clobbered: new Set(), trustRaw: false };
  }
};

const UNAVAILABLE_DYNAMIC_SYMBOLS =
  "DT_SYMTAB does not identify a decoded symbol table; dynamic relocation symbols are unresolved.";

const dynamicSymbols = (
  scan: ElfScan,
  sections: readonly NativeSection[],
  tags: ReadonlyMap<bigint, DynTag>,
  tables: ReadonlyMap<number, readonly ElfInitializerSymbol[]>,
): {
  readonly symbols: readonly ElfInitializerSymbol[] | undefined;
  readonly unavailable: boolean;
} => {
  const declared = tags.get(DT_SYMTAB);
  if (declared !== undefined) {
    const match = sections.findIndex(
      (section) =>
        section.address === declared.value &&
        (section.type === 11 || section.type === 2),
    );
    if (match >= 0) return { symbols: tables.get(match), unavailable: false };
    // A declared table that was not decoded is not replaced by another table.
    // Coverage drops only when a relocation actually asks for a symbol.
    return { symbols: undefined, unavailable: true };
  }
  const dynsym = sections.findIndex((section) => section.type === 11);
  return {
    symbols: dynsym < 0 ? undefined : tables.get(dynsym),
    unavailable: false,
  };
};

const fromDynamicWrite = (
  scan: ElfScan,
  write: ElfPointerWrite,
  symbols: readonly ElfInitializerSymbol[] | undefined,
  symbolsUnavailable: boolean,
): SlotRelocation => {
  if (write.source.encoding === "relr")
    return {
      method: "relr",
      value: write.value,
      importName: null,
      definedName: null,
    };
  const relative = elfRelativeRelocationType(scan.machine, scan.bits);
  if (write.value !== null && write.source.kind === relative)
    return {
      method: "relative_addend",
      value: write.value,
      importName: null,
      definedName: null,
    };
  const { encoding, kind } = write.source;
  if (kind === null || write.symbol_index === null)
    return {
      method: "unresolved",
      value: null,
      importName: null,
      definedName: null,
    };
  if (symbolsUnavailable && write.symbol_index !== 0)
    note(scan, UNAVAILABLE_DYNAMIC_SYMBOLS, "unknown");
  return relocationFromEntry(
    scan,
    {
      type: kind,
      symbolIndex: write.symbol_index,
      ...(write.addend === null ? {} : { addend: write.addend }),
    },
    symbols,
    encoding === "rel"
      ? readInitializerWord(scan.reader, write.file_offset, scan.bits)
      : null,
  );
};

const rawRelocation = (
  scan: ElfScan,
  fileOffset: number | null,
): SlotRelocation => {
  const value = readInitializerWord(scan.reader, fileOffset, scan.bits);
  return value === null
    ? { method: "unresolved", value: null, importName: null, definedName: null }
    : { method: "raw", value, importName: null, definedName: null };
};

const UNRESOLVED: SlotRelocation = {
  method: "unresolved",
  value: null,
  importName: null,
  definedName: null,
};

/**
 * One array slot. `trustRaw` is false when dynamic or section relocation
 * coverage is incomplete, so a slot with no relocation found may still have one.
 */
const resolveSlot = (
  scan: ElfScan,
  slot: Slot,
  write: ElfPointerWrite | undefined,
  clobbered: boolean,
  sectionRel: SlotRelocation | undefined,
  symbols: readonly ElfInitializerSymbol[] | undefined,
  symbolsUnavailable: boolean,
  trustRaw: boolean,
): SlotRelocation => {
  if (clobbered) return UNRESOLVED;
  if (write !== undefined)
    return fromDynamicWrite(scan, write, symbols, symbolsUnavailable);
  if (sectionRel !== undefined) return sectionRel;
  if (!trustRaw) return UNRESOLVED;
  return rawRelocation(scan, slot.fileOffset);
};

type SymbolNames = Pick<ElfSymbolIndex, "defined" | "definedInSection">;

const symbolOf = (
  scan: ElfScan,
  applied: SlotRelocation,
  names: SymbolNames,
): InitializerSymbolName | null => {
  if (applied.method === "unresolved_import") return applied.importName;
  const direct =
    applied.method === "symbol_addend" ? applied.definedName : null;
  if (typeof direct === "string" || applied.value === null) return direct;
  const indexed = !scan.relocatable
    ? names.defined.get(applied.value)
    : applied.sectionIndex === undefined
      ? undefined
      : names.definedInSection.get(
          sectionSymbolKey(applied.sectionIndex, applied.value),
        );
  return preferInitializerSymbolName(direct, indexed);
};

interface Target {
  readonly section: string | null;
  readonly fileOffset: number | null;
}

/**
 * Where a resolved value points. `locateTarget` maps one byte, since a function
 * only needs its first byte mapped. ET_REL values are offsets inside the
 * relocation symbol's section. On 32-bit ARM, bit 0 of a function pointer
 * selects Thumb state and is not part of the code address, so it is cleared
 * for the lookup while `value_va` keeps the callable value.
 */
const targetOf = (
  scan: ElfScan,
  applied: SlotRelocation,
  sections: readonly NativeSection[],
  index: ElfSectionIndex,
  locateTarget: (address: bigint) => number | null,
): Target => {
  if (applied.value === null) return { section: null, fileOffset: null };
  const code = scan.machine === EM_ARM ? applied.value & ~1n : applied.value;
  if (!scan.relocatable)
    return {
      section: index.nameAt(code),
      fileOffset: locateTarget(code),
    };
  const section =
    applied.sectionIndex === undefined
      ? undefined
      : sections[applied.sectionIndex];
  if (section === undefined) return { section: null, fileOffset: null };
  return {
    section: section.name,
    fileOffset: withinSection(section, 1)(section.address + code),
  };
};

const collectEntries = (
  scan: ElfScan,
  sources: readonly Source[],
  loaded: WriteLoad,
  sectionRels: ReadonlyMap<string, SlotRelocation>,
  sectionClobbered: ReadonlySet<string>,
  symbols: readonly ElfInitializerSymbol[] | undefined,
  symbolsUnavailable: boolean,
  names: SymbolNames,
  trustRaw: boolean,
  sections: readonly NativeSection[],
  index: ElfSectionIndex,
  locateTarget: (address: bigint) => number | null,
  signal: AbortSignal | undefined,
): { readonly entries: CollectedInitializer[]; readonly examined: number } => {
  const entries: CollectedInitializer[] = [];
  let scanned = 0;
  let skipped = 0;
  let zeroNoted = false;
  let stopped = false;
  for (const source of sources) {
    for (const slot of source.slots) {
      if (scanned >= MAX_NATIVE_INITIALIZER_ENTRIES) {
        stopped = true;
        break;
      }
      scanned += 1;
      if (scanned % 1024 === 0) assertArtifactReadActive(signal);
      const applied: SlotRelocation =
        slot.direct === undefined && slot.mappingMismatch === true
          ? {
              method: "unresolved",
              value: null,
              importName: null,
              definedName: null,
            }
          : slot.direct === undefined
            ? resolveSlot(
                scan,
                slot,
                scan.relocatable ? undefined : loaded.writes.get(slot.va),
                (!scan.relocatable && loaded.clobbered.has(slot.va)) ||
                  sectionClobbered.has(
                    elfInitializerSlotKey(slot, scan.relocatable),
                  ),
                sectionRels.get(elfInitializerSlotKey(slot, scan.relocatable)),
                symbols,
                symbolsUnavailable,
                trustRaw,
              )
            : {
                method: "raw",
                value: slot.direct,
                importName: null,
                definedName: null,
              };
      if (
        source.sentinel &&
        applied.method === "raw" &&
        applied.value !== null &&
        isSentinel(applied.value, scan.bits)
      ) {
        skipped += 1;
        continue;
      }
      if (!zeroNoted && applied.method === "raw" && applied.value === 0n) {
        zeroNoted = true;
        note(
          scan,
          "A stored zero slot is listed so the array length stays visible. It is not a function address.",
          "complete",
        );
      }
      const target = targetOf(scan, applied, sections, index, locateTarget);
      entries.push({
        index: entries.length,
        kind: source.kind,
        slotVa: slot.va,
        slotFileOffset: slot.fileOffset,
        slotBytes: scan.bits === 64 ? 8 : 4,
        valueVa: applied.value,
        valueFileOffset: target.fileOffset,
        slotSection: slot.sectionName,
        section: target.section,
        symbol: symbolOf(scan, applied, names),
        resolution: applied.method,
        detail: source.detail,
      });
    }
    if (stopped) break;
  }
  if (stopped)
    note(
      scan,
      "Initializer scanning stopped at 65536 slots. Later slots were not read.",
      "partial",
    );
  if (skipped > 0)
    note(
      scan,
      `Omitted ${String(skipped)} .ctors or .dtors sentinel values (0 or -1).`,
      "complete",
    );
  return { entries, examined: scanned };
};

/** Decode ELF initializer and finalizer slots for one thin image. */
export const readElfInitializers = async (
  bytes: Buffer,
  page: InitializerPage,
  signal?: AbortSignal,
): Promise<NativeInitializerInspection> => {
  assertArtifactReadActive(signal);
  const operation = "inspect_native_initializers";
  const directory =
    signal === undefined
      ? readElfDirectoryFromBuffer(bytes, operation)
      : await readElfDirectoryFromBufferCooperative(
          bytes,
          () => yieldArtifactRead(signal),
          operation,
        );
  assertArtifactReadActive(signal);
  const image = readElfImageFromDirectory(bytes, directory);
  const scan: ElfScan = {
    bytes,
    reader: new BinaryReader(bytes, image.byte_order === "little", "elf"),
    bits: image.bits,
    little: image.byte_order === "little",
    machine: image.elf.machine,
    relocatable: directory.elf_type === ET_REL,
    notes: new InitializerNotes(),
    coverage: "complete",
    slotBudget: MAX_NATIVE_INITIALIZER_ENTRIES,
  };
  if (scan.relocatable)
    note(
      scan,
      "Relocatable object (ET_REL): section-associated slot and value addresses are offsets inside that section, not load addresses. Absolute symbols do not name a section.",
      "complete",
    );
  const tags = readDynamicTags(
    scan,
    image.elf.dynamicSegments[0],
    image.elf.dynamicSegments.length > 1 ? 1 : 0,
  );
  const namesKnown = directory.section_names_limitation === undefined;
  if (!namesKnown && directory.section_names_limitation !== undefined)
    note(scan, directory.section_names_limitation, "unknown");
  const classified = classifySections(directory.sections, namesKnown);
  const index = classified.index;
  const mappings = createFileMappingIndex(image.mappings, image.zero_fills);
  const locate = (address: bigint): number | null =>
    fileOffsetFor(scan, mappings, address, wordOf(scan.bits));
  const locateTarget = (address: bigint): number | null =>
    fileOffsetFor(scan, mappings, address, 1);
  const declaredSources = collectSources(scan, tags, classified, locate);
  const sources = scan.relocatable
    ? declaredSources
    : declaredSources.map((source) => ({
        ...source,
        slots: source.slots.map((slot) => {
          if (
            slot.direct !== undefined ||
            slot.fileOffset === null ||
            slot.sectionIndex === null
          )
            return slot;
          let mapped: number | null = null;
          try {
            mapped = mappings.offset(slot.va, wordOf(scan.bits));
          } catch (cause) {
            if (!(cause instanceof BinaryMappingFailure)) throw cause;
          }
          if (mapped === slot.fileOffset) return slot;
          note(
            scan,
            "An ELF initializer slot's section offset disagrees with its load mapping; affected slots are unresolved.",
            "unknown",
          );
          return { ...slot, mappingMismatch: true };
        }),
      }));
  const wanted = new Set(
    sources.flatMap((source) =>
      source.slots.flatMap((slot) =>
        slot.direct === undefined ? [slot.va] : [],
      ),
    ),
  );
  const loaded = await loadWrites(scan, image, wanted, signal);
  assertArtifactReadActive(signal);
  const symbols = loadElfSymbolIndex(scan, directory.sections, scan.notes);
  // Missing or budget-stopped symbols leave unknown which listed slots lack a name.
  if (symbols.incomplete)
    scan.coverage = joinCoverageStatus([scan.coverage, "unknown"]);
  const uncovered = sources.flatMap((source) =>
    source.slots.flatMap((slot) =>
      slot.direct === undefined &&
      slot.fileOffset !== null &&
      (scan.relocatable ||
        (!loaded.writes.has(slot.va) && !loaded.clobbered.has(slot.va)))
        ? [slot]
        : [],
    ),
  );
  const notesBeforeRelocs = scan.notes.recorded;
  const sectionRels = await sectionRelocations({
    ...scan,
    sections: directory.sections,
    wanted: uncovered,
    tables: symbols.tables,
    notes: scan.notes,
    fileOffset: (address, width) =>
      fileOffsetFor(scan, mappings, address, width),
    signal,
  });
  if (scan.notes.recorded !== notesBeforeRelocs || !sectionRels.complete)
    scan.coverage = joinCoverageStatus([scan.coverage, "unknown"]);
  const dynamic = dynamicSymbols(
    scan,
    directory.sections,
    tags,
    symbols.tables,
  );
  const collected = collectEntries(
    scan,
    sources,
    loaded,
    sectionRels.found,
    sectionRels.clobbered,
    dynamic.symbols,
    dynamic.unavailable,
    symbols,
    loaded.trustRaw && sectionRels.complete,
    directory.sections,
    index,
    locateTarget,
    signal,
  );
  const architecture = elfArchitecture(scan.machine) ?? null;
  return finishInitializerReport(
    {
      format: "elf",
      architecture,
      bits: scan.bits,
      byte_order: image.byte_order,
      machine: scan.machine,
      elf_type: directory.elf_type,
      slice: null,
    },
    collected.entries,
    collected.examined,
    scan.notes,
    page,
    scan.coverage,
  );
};
