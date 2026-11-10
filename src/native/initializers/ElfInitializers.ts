import { setImmediate as immediate } from "node:timers/promises";
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import { readElfDynamicEntry } from "../../domain/elfDynamicEntry.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import {
  MAX_NATIVE_INITIALIZER_ENTRIES,
  MAX_NATIVE_INITIALIZER_NAME_BYTES,
  type NativeInitializerInspection,
  type NativeInitializerKind,
} from "../../domain/native/nativeInitializers.js";
import type { ElfPointerWrite } from "../metadata/ElfPointerRelocations.js";
import {
  ElfPointerRelocationFailure,
  elfRelativeRelocationType,
  readElfRelocationWritesSteps,
} from "../metadata/ElfPointerRelocations.js";
import { readElfImage } from "../metadata/ElfImage.js";
import {
  BinaryFormatFailure,
  BinaryMappingFailure,
  BinaryResourceFailure,
  createFileMappingIndex,
  mappedFileOffset,
  type FileMappingIndex,
} from "../metadata/BinaryContainer.js";
import { readElfDirectoryFromBuffer } from "../metadata/NativeSectionDirectory.js";
import type { NativeSection } from "../metadata/NativeSectionDirectory.js";
import {
  loadElfSymbolIndex,
  readPointerWord,
  relocationFromEntry,
  sectionRelocations,
  sectionSymbolKey,
  type ElfInitializerSymbol,
  type SlotRelocation,
} from "./ElfInitializerSymbols.js";
import {
  finishInitializerReport,
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
}

interface ArraySlot {
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
  readonly bytes: Buffer;
  readonly bits: 32 | 64;
  readonly little: boolean;
  readonly machine: number;
  readonly relocatable: boolean;
  readonly notes: InitializerNotes;
  incomplete: boolean;
  /** Array slots still walkable across every source, so a declared size never sets the work. */
  slotBudget: number;
}

const note = (scan: ElfScan, message: string, incomplete = true): void => {
  scan.notes.add(message);
  if (incomplete) scan.incomplete = true;
};

const wordOf = (bits: 32 | 64): number => bits / 8;

/** `.ctors` / `.dtors` sentinels: 0 and all-ones at the image's pointer width. */
const isSentinel = (value: bigint, bits: 32 | 64): boolean =>
  value === 0n || value === (1n << BigInt(bits)) - 1n;

/** Read the consumed DT_* tags. The first duplicate wins. A missing DT_NULL stays incomplete. */
const readDynamicTags = (
  scan: ElfScan,
  segment: { readonly offset: bigint; readonly size: bigint } | undefined,
  extra: number,
): Map<bigint, DynTag> => {
  const tags = new Map<bigint, DynTag>();
  if (segment === undefined) return tags;
  if (extra > 0)
    throw new BinaryFormatFailure("malformed", "multiple PT_DYNAMIC segments");
  const width = scan.bits === 64 ? 16 : 8;
  const start = Number(segment.offset);
  const size = Number(segment.size);
  if (size > 16 * 1024 * 1024)
    throw new BinaryResourceFailure(
      "structure",
      16 * 1024 * 1024,
      "ELF dynamic directory exceeds the 16 MiB structural allowance",
    );
  if (
    size < 0 ||
    size % width !== 0 ||
    start < 0 ||
    start > scan.bytes.length ||
    size > scan.bytes.length - start
  )
    throw new BinaryFormatFailure(
      "malformed",
      "PT_DYNAMIC is truncated or outside the file",
    );
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
      );
      continue;
    }
    tags.set(parsed.value.tag, {
      value: parsed.value.value,
      valueOffset: at + wordOf(scan.bits),
    });
  }
  if (!terminated)
    note(
      scan,
      "PT_DYNAMIC has no DT_NULL terminator. Tags seen before the end were used.",
    );
  return tags;
};

/**
 * File offset of `size` bytes at `address`: a whole slot, or a target's first
 * byte. `mappings` is built once per image, so each lookup is logarithmic. Only
 * a genuinely unmapped span falls back to section headers; an ambiguous one
 * stays unknown and makes the report incomplete.
 */
const fileOffsetFor = (
  scan: ElfScan,
  mappings: FileMappingIndex,
  index: ElfSectionIndex,
  address: bigint,
  size: number,
): number | null => {
  try {
    return mappings.offset(address, size);
  } catch (cause) {
    if (!(cause instanceof BinaryMappingFailure)) throw cause;
    if (cause.reason === "ambiguous") {
      note(scan, AMBIGUOUS_MAPPING);
      return null;
    }
    return index.fileOffsetAt(address, size);
  }
};

const AMBIGUOUS_MAPPING =
  "An address has ambiguous file mappings (overlapping load segments with different file offsets, or file and zero-fill memory), so its file offset is not reported.";

const vaForFile = (
  mappings: Parameters<typeof mappedFileOffset>[0],
  fileOffset: number,
): bigint | null => {
  for (const mapping of mappings) {
    if (
      fileOffset < mapping.offset ||
      fileOffset >= mapping.offset + mapping.size
    )
      continue;
    return mapping.address + BigInt(fileOffset - mapping.offset);
  }
  return null;
};

/** Address lookups over the section headers, built once per image. */
interface ElfSectionIndex {
  /** Name of the smallest SHF_ALLOC section containing `address`; earlier headers win ties. */
  readonly nameAt: (address: bigint) => string | null;
  /**
   * File offset of `width` bytes at `address` in the first file-backed section,
   * in header order, that covers `address`. Null when that section ends before
   * the span does.
   */
  readonly fileOffsetAt: (address: bigint, width: number) => number | null;
}

const indexSections = (sections: readonly NativeSection[]): ElfSectionIndex => {
  const ranges = (keep: (section: NativeSection) => boolean) =>
    sections.flatMap((section) =>
      keep(section)
        ? [
            {
              start: section.address,
              end: section.address + section.size,
              value: section,
            },
          ]
        : [],
    );
  const named = buildAddressRangeIndex(
    ranges((section) => section.size !== 0n && (section.flags & 2n) !== 0n),
    (left, right) =>
      left.size < right.size
        ? -1
        : left.size > right.size
          ? 1
          : left.index - right.index,
  );
  const backed = buildAddressRangeIndex(
    ranges((section) => section.file_backed && !section.compressed),
    (left, right) => left.index - right.index,
  );
  return {
    nameAt(address) {
      const name = named.at(address)?.value.name;
      return name == null || name.length === 0 ? null : name;
    },
    fileOffsetAt(address, width) {
      const section = backed.at(address)?.value;
      if (
        section === undefined ||
        address + BigInt(width) > section.address + section.size
      )
        return null;
      return Number(section.offset) + Number(address - section.address);
    },
  };
};

const slotsFromSpan = (
  scan: ElfScan,
  base: bigint,
  byteSize: bigint,
  label: string,
  locate: (address: bigint) => number | null,
  sectionName: string | null,
): Slot[] => {
  const stride = BigInt(wordOf(scan.bits));
  if (byteSize < 0n || byteSize % stride !== 0n)
    note(
      scan,
      byteSize < 0n
        ? `${label} size is negative.`
        : `${label} size is not a multiple of the pointer width. Trailing bytes were not read.`,
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
    );
  const slots: Slot[] = [];
  let missed = false;
  for (let index = 0; index < count; index += 1) {
    const va = base + BigInt(index) * stride;
    const fileOffset = locate(va);
    if (fileOffset === null) {
      missed = true;
      continue;
    }
    slots.push({ va, fileOffset, sectionName });
  }
  if (missed)
    note(
      scan,
      `${label} has slots that are not file-backed. Those slots were omitted.`,
    );
  return slots;
};

/** Output sections, plus `.name.*` input sections in relocatable objects. */
const matchesName = (section: NativeSection, name: string): boolean =>
  section.name === name || (section.name?.startsWith(`${name}.`) ?? false);

const findSections = (
  sections: readonly NativeSection[],
  type: number | null,
  name: string,
  namesKnown: boolean,
): NativeSection[] =>
  sections.filter(
    (section) =>
      (type !== null && section.type === type) ||
      (namesKnown && matchesName(section, name)),
  );

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
    );
    return { kind, sentinel, detail: label, slots: [] };
  }
  if (!section.file_backed) {
    note(scan, `${label} is not file-backed. Its slots were omitted.`);
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
    ),
  };
};

interface ArrayRequest {
  readonly kind: NativeInitializerKind;
  readonly addressTag: bigint;
  readonly sizeTag: bigint;
  readonly sectionType: number;
  readonly sectionName: string;
  readonly detail: string;
}

/** DT_* array when declared, otherwise every matching section in header order. */
const arraySources = (
  scan: ElfScan,
  tags: ReadonlyMap<bigint, DynTag>,
  sections: readonly NativeSection[],
  index: ElfSectionIndex,
  request: ArrayRequest,
  locate: (address: bigint) => number | null,
  namesKnown: boolean,
): Source[] => {
  const address = tags.get(request.addressTag);
  if (address === undefined)
    return findSections(
      sections,
      request.sectionType,
      request.sectionName,
      namesKnown,
    ).map((section) =>
      sectionSource(scan, section, request.kind, false, request.sectionName),
    );
  const size = tags.get(request.sizeTag);
  if (size === undefined) {
    note(scan, `${request.detail} has no size tag. Its slots were not read.`);
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
        index.nameAt(address.value),
      ),
    },
  ];
};

const legacySources = (
  scan: ElfScan,
  sections: readonly NativeSection[],
  name: ".ctors" | ".dtors",
  kind: NativeInitializerKind,
  namesKnown: boolean,
): Source[] =>
  findSections(sections, null, name, namesKnown).map((section) =>
    sectionSource(scan, section, kind, true, name),
  );

const directSource = (
  scan: ElfScan,
  tags: ReadonlyMap<bigint, DynTag>,
  index: ElfSectionIndex,
  mappings: Parameters<typeof mappedFileOffset>[0],
  tag: bigint,
  kind: NativeInitializerKind,
  detail: string,
): Source | null => {
  const entry = tags.get(tag);
  if (entry === undefined) return null;
  const va = vaForFile(mappings, entry.valueOffset);
  // DT_INIT / DT_FINI store the target, not a slot pointer, so an unmapped field has no slot address.
  if (va === null)
    note(scan, `${detail} value field is not inside a load segment.`);
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
    sectionType: SHT_PREINIT_ARRAY,
    sectionName: ".preinit_array",
    detail: "DT_PREINIT_ARRAY",
  },
  {
    kind: "init_array",
    addressTag: DT_INIT_ARRAY,
    sizeTag: DT_INIT_ARRAYSZ,
    sectionType: SHT_INIT_ARRAY,
    sectionName: ".init_array",
    detail: "DT_INIT_ARRAY",
  },
  {
    kind: "fini_array",
    addressTag: DT_FINI_ARRAY,
    sizeTag: DT_FINI_ARRAYSZ,
    sectionType: SHT_FINI_ARRAY,
    sectionName: ".fini_array",
    detail: "DT_FINI_ARRAY",
  },
];

const collectSources = (
  scan: ElfScan,
  tags: ReadonlyMap<bigint, DynTag>,
  sections: readonly NativeSection[],
  index: ElfSectionIndex,
  mappings: Parameters<typeof mappedFileOffset>[0],
  locate: (address: bigint) => number | null,
  namesKnown: boolean,
): Source[] => {
  const [preinit, initArray, finiArray] = ARRAYS.map((request) =>
    arraySources(scan, tags, sections, index, request, locate, namesKnown),
  );
  const init = directSource(
    scan,
    tags,
    index,
    mappings,
    DT_INIT,
    "init",
    "DT_INIT",
  );
  const fini = directSource(
    scan,
    tags,
    index,
    mappings,
    DT_FINI,
    "fini",
    "DT_FINI",
  );
  return [
    ...(preinit ?? []),
    ...(init === null ? [] : [init]),
    ...(initArray ?? []),
    ...legacySources(scan, sections, ".ctors", "ctors", namesKnown),
    ...(fini === null ? [] : [fini]),
    ...(finiArray ?? []),
    ...legacySources(scan, sections, ".dtors", "dtors", namesKnown),
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
      { unsupported: "record" },
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
      );
    if (!next.value.pointer_coverage_known) {
      const issues = next.value.issues;
      if (issues.length === 0)
        note(scan, "Dynamic relocation coverage is incomplete.");
      for (const issue of issues) note(scan, issue);
      return { writes, clobbered, trustRaw: false };
    }
    return { writes, clobbered, trustRaw: true };
  } catch (cause) {
    if (!(cause instanceof ElfPointerRelocationFailure)) throw cause;
    if (cause.reason === "native-index-capacity")
      throw new BinaryResourceFailure(
        "structure",
        16 * 1024 * 1024,
        cause.message,
      );
    note(scan, cause.message);
    return { writes: new Map(), clobbered: new Set(), trustRaw: false };
  }
};

const dynamicSymbols = (
  scan: ElfScan,
  sections: readonly NativeSection[],
  tags: ReadonlyMap<bigint, DynTag>,
  tables: ReadonlyMap<number, readonly ElfInitializerSymbol[]>,
): readonly ElfInitializerSymbol[] | undefined => {
  const declared = tags.get(DT_SYMTAB);
  if (declared !== undefined) {
    const match = sections.findIndex(
      (section) =>
        section.address === declared.value &&
        (section.type === 11 || section.type === 2),
    );
    if (match >= 0) return tables.get(match);
    note(
      scan,
      "DT_SYMTAB does not identify a decoded symbol table; dynamic relocation symbols are unresolved.",
    );
    return undefined;
  }
  const dynsym = sections.findIndex((section) => section.type === 11);
  return dynsym < 0 ? undefined : tables.get(dynsym);
};

const fromDynamicWrite = (
  scan: ElfScan,
  write: ElfPointerWrite,
  symbols: readonly ElfInitializerSymbol[] | undefined,
): SlotRelocation => {
  if (write.source.encoding === "relr")
    return {
      method: "relr",
      value: write.value,
      importName: null,
      definedName: null,
    };
  const relative = elfRelativeRelocationType(scan.machine);
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
  return relocationFromEntry(
    scan,
    {
      type: kind,
      symbolIndex: write.symbol_index,
      ...(write.addend === null ? {} : { addend: write.addend }),
    },
    symbols,
    encoding === "rel"
      ? readPointerWord(scan.bytes, write.file_offset, scan.bits, scan.little)
      : null,
  );
};

const rawRelocation = (
  scan: ElfScan,
  fileOffset: number | null,
): SlotRelocation => {
  const value = readPointerWord(scan.bytes, fileOffset, scan.bits, scan.little);
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
  trustRaw: boolean,
): SlotRelocation => {
  if (clobbered) return UNRESOLVED;
  if (write !== undefined) return fromDynamicWrite(scan, write, symbols);
  if (sectionRel !== undefined) return sectionRel;
  if (!trustRaw) return UNRESOLVED;
  return rawRelocation(scan, slot.fileOffset);
};

interface SymbolNames {
  readonly defined: ReadonlyMap<bigint, string>;
  readonly definedInSection: ReadonlyMap<string, string>;
}

const symbolOf = (
  scan: ElfScan,
  applied: SlotRelocation,
  names: SymbolNames,
): string | null => {
  if (applied.method === "unresolved_import") return applied.importName;
  if (applied.method === "symbol_addend" && applied.definedName !== null)
    return applied.definedName;
  if (applied.value === null) return null;
  if (scan.relocatable)
    return applied.sectionIndex === undefined
      ? null
      : (names.definedInSection.get(
          sectionSymbolKey(applied.sectionIndex, applied.value),
        ) ?? null);
  return names.defined.get(applied.value) ?? null;
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
  sectionRels: ReadonlyMap<number, SlotRelocation>,
  sectionClobbered: ReadonlySet<number>,
  symbols: readonly ElfInitializerSymbol[] | undefined,
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
                  (slot.fileOffset !== null &&
                    sectionClobbered.has(slot.fileOffset)),
                slot.fileOffset === null
                  ? undefined
                  : sectionRels.get(slot.fileOffset),
                symbols,
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
          false,
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
    );
  if (skipped > 0)
    note(
      scan,
      `Omitted ${String(skipped)} .ctors or .dtors sentinel values (0 or -1).`,
      false,
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
  const image = readElfImage(bytes);
  const directory = readElfDirectoryFromBuffer(bytes);
  const scan: ElfScan = {
    bytes,
    bits: image.bits,
    little: image.byte_order === "little",
    machine: image.elf.machine,
    relocatable: directory.elf_type === ET_REL,
    notes: new InitializerNotes(),
    incomplete: false,
    slotBudget: MAX_NATIVE_INITIALIZER_ENTRIES,
  };
  if (scan.relocatable)
    note(
      scan,
      "Relocatable object (ET_REL): slot and value addresses are offsets inside the named section, not load addresses.",
      false,
    );
  const tags = readDynamicTags(
    scan,
    image.elf.dynamicSegments[0],
    image.elf.dynamicSegments.length > 1 ? 1 : 0,
  );
  const namesKnown = directory.section_names_limitation === undefined;
  if (!namesKnown && directory.section_names_limitation !== undefined)
    note(scan, directory.section_names_limitation);
  const index = indexSections(directory.sections);
  const mappings = createFileMappingIndex(image.mappings, image.zero_fills);
  const locate = (address: bigint): number | null =>
    fileOffsetFor(scan, mappings, index, address, wordOf(scan.bits));
  const locateTarget = (address: bigint): number | null =>
    fileOffsetFor(scan, mappings, index, address, 1);
  const declaredSources = collectSources(
    scan,
    tags,
    directory.sections,
    index,
    image.mappings,
    locate,
    namesKnown,
  );
  const sources = scan.relocatable
    ? declaredSources
    : declaredSources.map((source) => ({
        ...source,
        slots: source.slots.map((slot) => {
          if (slot.direct !== undefined || slot.fileOffset === null)
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
  if (symbols.incomplete) scan.incomplete = true;
  const uncovered = new Set(
    sources.flatMap((source) =>
      source.slots.flatMap((slot) =>
        slot.direct === undefined &&
        slot.fileOffset !== null &&
        (scan.relocatable ||
          (!loaded.writes.has(slot.va) && !loaded.clobbered.has(slot.va)))
          ? [slot.fileOffset]
          : [],
      ),
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
      fileOffsetFor(scan, mappings, index, address, width),
    signal,
  });
  if (scan.notes.recorded !== notesBeforeRelocs || !sectionRels.complete)
    scan.incomplete = true;
  const collected = collectEntries(
    scan,
    sources,
    loaded,
    sectionRels.found,
    sectionRels.clobbered,
    dynamicSymbols(scan, directory.sections, tags, symbols.tables),
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
    scan.incomplete,
  );
};
