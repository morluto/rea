import { setImmediate as immediate } from "node:timers/promises";
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import { readElfRelocationEntry } from "../../domain/elfRelocation.js";
import { readElfSymbol } from "../../domain/elfSymbol.js";
import {
  elfStringTableText,
  observeElfStringTableEntry,
} from "../../domain/elfStringTable.js";
import { MAX_NATIVE_INITIALIZER_NAME_BYTES } from "../../domain/native/nativeInitializers.js";
import type { NativeInitializerResolution } from "../../domain/native/nativeInitializers.js";
import {
  elfAbsoluteRelocationType,
  elfRelativeRelocationType,
  elfRelocationWidth,
} from "../metadata/ElfPointerRelocations.js";
import type { NativeSection } from "../metadata/NativeSectionDirectory.js";
import type { InitializerNotes } from "./initializerNotes.js";

/** One symbol-table row. `section` 0 is an undefined import. */
export interface ElfInitializerSymbol {
  readonly name: string | null;
  readonly value: bigint;
  readonly section: number;
  readonly type: number;
}

/** Defined exact-address names plus per-section symbol arrays. */
export interface ElfSymbolIndex {
  readonly defined: ReadonlyMap<bigint, string>;
  /** Relocatable objects: names keyed by `section:value`, since every section starts at 0. */
  readonly definedInSection: ReadonlyMap<string, string>;
  readonly tables: ReadonlyMap<number, readonly ElfInitializerSymbol[]>;
  /** A table was truncated by a budget or could not be read. */
  readonly incomplete: boolean;
}

/** A relocation applied to one slot. `definedName` is the reloc symbol. */
export interface SlotRelocation {
  readonly method: NativeInitializerResolution;
  readonly value: bigint | null;
  readonly importName: string | null;
  readonly definedName: string | null;
  /** Section index of the relocation symbol, used for relocatable objects. */
  readonly sectionIndex?: number;
}

const STT_FUNC = 2;
const STT_SECTION = 3;
const STT_FILE = 4;
/** `st_value` is a resolver; the loader writes whatever the resolver returns. */
const STT_GNU_IFUNC = 10;

/** Key for a symbol defined at `value` inside section `section`. */
export const sectionSymbolKey = (section: number, value: bigint): string =>
  `${String(section)}:${value.toString(16)}`;

/** Symbols decoded across every SHT_SYMTAB and SHT_DYNSYM table together. */
const SYMBOL_SCAN = 65536;
/** REL/RELA records decoded across every relocation section together. */
const SECTION_RELOCATION_RECORD_SCAN = 1_048_576;

interface ImageFacts {
  readonly bits: 32 | 64;
  readonly little: boolean;
  readonly machine: number;
  readonly bytes: Buffer;
}

const wordOf = (bits: 32 | 64): number => bits / 8;

/** In-place word used as a REL addend. Null when the slot is not file-backed. */
export const readPointerWord = (
  bytes: Buffer,
  offset: number | null,
  bits: 32 | 64,
  little: boolean,
): bigint | null => {
  const width = wordOf(bits);
  if (offset === null || offset < 0 || offset > bytes.length - width)
    return null;
  if (bits === 64)
    return little
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);
  return BigInt(
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset),
  );
};

/**
 * Name at `offset`. Offset 0 is the empty name. A missing string table or an
 * offset outside it is an unreadable name, which `missing` keeps visible.
 */
const stringAt = (
  table: Buffer | null,
  offset: number,
  notes: InitializerNotes,
): { readonly name: string | null; readonly missing: boolean } => {
  if (offset === 0) return { name: null, missing: false };
  if (table === null) {
    notes.tally("unreadable-symbol-name");
    return { name: null, missing: true };
  }
  const observed = observeElfStringTableEntry(
    table,
    offset,
    MAX_NATIVE_INITIALIZER_NAME_BYTES + 1,
  );
  if (observed.state === "truncated") {
    notes.tally("long-symbol-name");
    return { name: null, missing: true };
  }
  if (observed.state === "outside") {
    notes.tally("unreadable-symbol-name");
    return { name: null, missing: true };
  }
  const text = elfStringTableText(observed);
  if (
    text === null ||
    text.length === 0 ||
    text.length > MAX_NATIVE_INITIALIZER_NAME_BYTES
  )
    return { name: null, missing: false };
  return { name: text, missing: false };
};

const stringTableBytes = (
  bytes: Buffer,
  section: NativeSection | undefined,
): Buffer | null => {
  if (
    section === undefined ||
    section.type !== 3 ||
    !section.file_backed ||
    section.compressed
  )
    return null;
  const offset = Number(section.offset);
  const size = Number(section.size);
  if (offset < 0 || size < 0 || offset > bytes.length - size) return null;
  return bytes.subarray(offset, offset + size);
};

const readTable = (
  facts: ImageFacts,
  sections: readonly NativeSection[],
  section: NativeSection,
  budget: number,
  notes: InitializerNotes,
): {
  readonly symbols: ElfInitializerSymbol[];
  readonly truncated: boolean;
  readonly incomplete: boolean;
} => {
  const width = facts.bits === 64 ? 24 : 16;
  const strings = stringTableBytes(facts.bytes, sections[section.link]);
  const compressedStrings = sections[section.link]?.compressed === true;
  if (compressedStrings)
    notes.add(
      "A symbol string table is compressed; its names were not decoded.",
    );
  else if (strings === null)
    notes.add(
      "A symbol table does not link a readable SHT_STRTAB section; its names were not decoded.",
    );
  const start = Number(section.offset);
  const declared = section.size / BigInt(width);
  const count = Number(declared < BigInt(budget) ? declared : BigInt(budget));
  const truncated = declared > BigInt(budget);
  if (truncated)
    notes.add(
      `Symbol table scanning stopped at ${String(SYMBOL_SCAN)} symbols across all symbol tables. Later names may be missing.`,
    );
  const symbols: ElfInitializerSymbol[] = [];
  let nameMissing = false;
  for (let index = 0; index < count; index += 1) {
    const at = start + index * width;
    const parsed = readElfSymbol(
      facts.bytes.subarray(at, at + width),
      facts.bits,
      facts.little,
    );
    if (!parsed.ok) {
      notes.add(parsed.error.message);
      break;
    }
    const named = stringAt(strings, parsed.value.name_offset, notes);
    nameMissing ||= named.missing;
    symbols.push({
      name: named.name,
      value: parsed.value.value,
      section: parsed.value.section_index,
      type: parsed.value.type,
    });
  }
  return { symbols, truncated, incomplete: nameMissing || strings === null };
};

/** Load SHT_SYMTAB and SHT_DYNSYM once. Defined STT_FUNC names win ties. */
export const loadElfSymbolIndex = (
  facts: ImageFacts,
  sections: readonly NativeSection[],
  notes: InitializerNotes,
): ElfSymbolIndex => {
  const tables = new Map<number, readonly ElfInitializerSymbol[]>();
  const ranked = new Map<
    bigint,
    { readonly name: string; readonly func: boolean }
  >();
  const inSection = new Map<
    string,
    { readonly name: string; readonly func: boolean }
  >();
  let truncated = false;
  const rank = <K>(
    map: Map<K, { readonly name: string; readonly func: boolean }>,
    key: K,
    name: string,
    func: boolean,
  ): void => {
    const previous = map.get(key);
    if (previous === undefined || (!previous.func && func))
      map.set(key, { name, func });
  };
  const consider = (symbol: ElfInitializerSymbol): void => {
    if (symbol.section === 0 || symbol.name === null) return;
    if (symbol.type === STT_SECTION || symbol.type === STT_FILE) return;
    const func = symbol.type === STT_FUNC;
    rank(ranked, symbol.value, symbol.name, func);
    rank(
      inSection,
      sectionSymbolKey(symbol.section, symbol.value),
      symbol.name,
      func,
    );
  };
  let budget = SYMBOL_SCAN;
  let unreadable = false;
  sections.forEach((section, index) => {
    if (truncated) return;
    if (section.type !== 2 && section.type !== 11) return;
    if (section.compressed) {
      notes.add("A symbol table is compressed; its symbols were not decoded.");
      unreadable = true;
      return;
    }
    const width = BigInt(facts.bits === 64 ? 24 : 16);
    if (section.entry_size !== 0n && section.entry_size !== width) {
      notes.add(
        "A symbol table has an unexpected entry size; its symbols were not decoded.",
      );
      unreadable = true;
      return;
    }
    if (!section.file_backed || section.size % width !== 0n) {
      notes.add(
        "A symbol table is not stored in the file or its size is not a whole number of entries, so its names were not read.",
      );
      unreadable = true;
      return;
    }
    const table = readTable(facts, sections, section, budget, notes);
    budget -= table.symbols.length;
    tables.set(index, table.symbols);
    truncated ||= table.truncated;
    unreadable ||= table.incomplete;
    for (const symbol of table.symbols) consider(symbol);
  });
  return {
    defined: new Map([...ranked].map(([address, row]) => [address, row.name])),
    definedInSection: new Map(
      [...inSection].map(([key, row]) => [key, row.name]),
    ),
    tables,
    incomplete: truncated || unreadable,
  };
};

const unresolved = (): SlotRelocation => ({
  method: "unresolved",
  value: null,
  importName: null,
  definedName: null,
});

const addendOf = (
  entry: { readonly addend?: bigint },
  inplace: bigint | null,
): bigint | null => (typeof entry.addend === "bigint" ? entry.addend : inplace);

/** Apply one REL or RELA record using its own symbol table. */
export const relocationFromEntry = (
  facts: ImageFacts,
  entry: {
    readonly type: number;
    readonly symbolIndex: number;
    readonly addend?: bigint;
  },
  symbols: readonly ElfInitializerSymbol[] | undefined,
  inplace: bigint | null,
): SlotRelocation => {
  const relative = elfRelativeRelocationType(facts.machine);
  const absolute = elfAbsoluteRelocationType(facts.machine);
  if (entry.type === relative && entry.symbolIndex === 0) {
    const addend = addendOf(entry, inplace);
    if (addend === null) return unresolved();
    return {
      method: "relative_addend",
      value: BigInt.asUintN(facts.bits, addend),
      importName: null,
      definedName: null,
    };
  }
  if (entry.symbolIndex === 0 || symbols === undefined) return unresolved();
  const symbol = symbols[entry.symbolIndex];
  if (symbol === undefined) return unresolved();
  if (symbol.section === 0)
    return {
      method: "unresolved_import",
      value: null,
      importName: symbol.name,
      definedName: null,
    };
  if (entry.type !== absolute || symbol.type === STT_GNU_IFUNC)
    return unresolved();
  const addend = addendOf(entry, inplace);
  if (addend === null) return unresolved();
  return {
    method: "symbol_addend",
    value: BigInt.asUintN(facts.bits, symbol.value + addend),
    importName: null,
    definedName:
      symbol.type === STT_SECTION || symbol.type === STT_FILE || addend !== 0n
        ? null
        : symbol.name,
    sectionIndex: symbol.section,
  };
};

/** A slot's relocation identity is its virtual address, or its section and address in ET_REL. */
export interface ElfInitializerSlot {
  readonly va: bigint;
  readonly sectionIndex: number | null;
}

/** One coordinate rule shared by relocation production and slot lookup. */
export const elfInitializerSlotKey = (
  slot: ElfInitializerSlot,
  relocatable: boolean,
): string =>
  relocatable
    ? sectionSymbolKey(slot.sectionIndex ?? -1, slot.va)
    : slot.va.toString(16);

interface SectionRelocInput extends ImageFacts {
  readonly sections: readonly NativeSection[];
  /** ET_REL: `r_offset` is relative to the section named by `sh_info`. */
  readonly relocatable: boolean;
  /** Slots not covered by dynamic relocations; source offsets do not establish write ownership. */
  readonly wanted: readonly ElfInitializerSlot[];
  readonly tables: ReadonlyMap<number, readonly ElfInitializerSymbol[]>;
  readonly notes: InitializerNotes;
  /** File offset of `width` bytes at a linked-image address. */
  readonly fileOffset: (address: bigint, width: number) => number | null;
  readonly signal?: AbortSignal | undefined;
}

/** Decode one REL or RELA record through the encoding-specific overload. */
const readRelocationRecord = (
  bytes: Buffer,
  bits: 32 | 64,
  little: boolean,
  encoding: "rel" | "rela",
) =>
  encoding === "rela"
    ? readElfRelocationEntry(bytes, bits, little, "rela")
    : readElfRelocationEntry(bytes, bits, little, "rel");

const encodingOf = (type: number): "rel" | "rela" | null =>
  type === 4 ? "rela" : type === 9 ? "rel" : null;

/** File offset of the `width` bytes one record writes, or null when they are not file-backed. */
const recordTarget = (
  input: SectionRelocInput,
  target: NativeSection | undefined,
  offset: bigint,
  width: number,
): number | null => {
  if (!input.relocatable) return input.fileOffset(offset, width);
  if (target === undefined || !target.file_backed) return null;
  if (offset < 0n || offset + BigInt(width) > target.size) return null;
  return Number(target.offset + offset);
};

/** Index of the first wanted slot whose word could overlap a write starting at `at`. */
const firstOverlap = (
  wanted: readonly ElfInitializerSlot[],
  at: bigint,
  word: number,
): number => {
  let low = 0;
  let high = wanted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((wanted[mid]?.va ?? at) <= at - BigInt(word)) low = mid + 1;
    else high = mid;
  }
  return low;
};

/** Section relocations found for wanted slots, and whether every applicable record was read. */
export interface SectionRelocationScan {
  readonly found: ReadonlyMap<string, SlotRelocation>;
  /** Slots a narrower, offset or repeated record overlaps; their value is unknown. */
  readonly clobbered: ReadonlySet<string>;
  /**
   * False when a relocation section was skipped, ended early or lies past the
   * record budget, so an unmatched slot may still have an unread relocation.
   */
  readonly complete: boolean;
}

const SHF_ALLOC = 2n;

/** Relocation sections this reader applies: every one in ET_REL, SHF_ALLOC ones otherwise. */
const applicable = (
  input: SectionRelocInput,
  section: NativeSection,
): "rel" | "rela" | null => {
  const encoding = encodingOf(section.type);
  if (encoding === null) return null;
  if (!input.relocatable && (section.flags & SHF_ALLOC) === 0n) return null;
  return encoding;
};

/**
 * Section REL/RELA records for slots that dynamic tables do not cover, keyed by
 * slot identity. In a linked image, a relocation section without SHF_ALLOC
 * is a link-time record the static linker already applied (for example from
 * `--emit-relocs`), so the slot already holds its result and is not reapplied.
 */
export const sectionRelocations = async (
  input: SectionRelocInput,
): Promise<SectionRelocationScan> => {
  const found = new Map<string, SlotRelocation>();
  const clobbered = new Set<string>();
  if (input.wanted.length === 0) return { found, clobbered, complete: true };
  // Linked writes use virtual addresses; ET_REL writes additionally belong to
  // sh_info's section, even when two sections reuse the same file bytes.
  const bySection = new Map<number | null, Map<bigint, ElfInitializerSlot>>();
  for (const slot of input.wanted) {
    const key = input.relocatable ? slot.sectionIndex : null;
    const slots = bySection.get(key) ?? new Map<bigint, ElfInitializerSlot>();
    slots.set(slot.va, slot);
    bySection.set(key, slots);
  }
  const sorted = new Map(
    [...bySection].map(([section, slots]) => [
      section,
      [...slots.values()].sort((left, right) =>
        left.va < right.va ? -1 : left.va > right.va ? 1 : 0,
      ),
    ]),
  );
  const wantedBy = (section: NativeSection): readonly ElfInitializerSlot[] =>
    sorted.get(input.relocatable ? section.info : null) ?? [];
  const word = wordOf(input.bits);
  let complete = true;
  const skip = (section: NativeSection): void => {
    if (wantedBy(section).length > 0) complete = false;
  };
  // One budget across every header, so many headers over one range cannot multiply the work.
  let budget = SECTION_RELOCATION_RECORD_SCAN;
  for (const [position, section] of input.sections.entries()) {
    const encoding = applicable(input, section);
    if (encoding === null) continue;
    if (!section.file_backed || section.compressed) {
      if (section.compressed)
        input.notes.add(
          "A relocation section is compressed; its records were not decoded.",
        );
      skip(section);
      continue;
    }
    const width = encoding === "rela" ? word * 3 : word * 2;
    const entsize =
      section.entry_size === 0n ? BigInt(width) : section.entry_size;
    if (entsize !== BigInt(width) || section.size % entsize !== 0n) {
      input.notes.tally("relocation-entry-size");
      skip(section);
      continue;
    }
    const symbols = input.tables.get(section.link);
    const target = input.relocatable ? input.sections[section.info] : undefined;
    const wanted = wantedBy(section);
    if (input.relocatable && target === undefined) {
      input.notes.add(
        "A relocation section names a target section that does not exist, so its records were not applied.",
      );
      continue;
    }
    const start = Number(section.offset);
    const declared = section.size / entsize;
    const count = Number(declared < BigInt(budget) ? declared : BigInt(budget));
    budget -= count;
    const stopped = declared > BigInt(count);
    if (stopped)
      input.notes.add(
        `Section relocation scanning stopped at ${String(SECTION_RELOCATION_RECORD_SCAN)} records across all relocation sections. Later records were not applied.`,
      );
    for (let index = 0; index < count; index += 1) {
      if (index % 4096 === 0) {
        await immediate();
        assertArtifactReadActive(input.signal);
      }
      const at = start + index * width;
      const parsed = readRelocationRecord(
        input.bytes.subarray(at, at + width),
        input.bits,
        input.little,
        encoding,
      );
      if (!parsed.ok) {
        input.notes.add(parsed.error.message);
        skip(section);
        break;
      }
      // An unknown type is assumed to write a whole word, so it still marks what it may touch.
      const span = elfRelocationWidth(input.machine, parsed.value.type) ?? word;
      if (span === 0) continue;
      if (recordTarget(input, target, parsed.value.offset, 1) === null) {
        skip(section);
        continue;
      }
      const written = parsed.value.offset + (target?.address ?? 0n);
      const writtenFileOffset = recordTarget(
        input,
        target,
        parsed.value.offset,
        span,
      );
      const fullWrite = writtenFileOffset !== null;
      if (!fullWrite) {
        complete = false;
        input.notes.add(
          "A section relocation extends beyond its target mapping; affected slots are unresolved.",
        );
      }
      for (
        let next = firstOverlap(wanted, written, word);
        next < wanted.length;
        next += 1
      ) {
        const slot = wanted[next];
        if (slot === undefined || slot.va >= written + BigInt(span)) break;
        const key = elfInitializerSlotKey(slot, input.relocatable);
        if (clobbered.has(key)) continue;
        if (
          fullWrite &&
          slot.va === written &&
          span === word &&
          !found.has(key)
        ) {
          const inplace =
            encoding === "rel"
              ? readPointerWord(
                  input.bytes,
                  writtenFileOffset,
                  input.bits,
                  input.little,
                )
              : null;
          found.set(
            key,
            relocationFromEntry(input, parsed.value, symbols, inplace),
          );
          continue;
        }
        found.delete(key);
        clobbered.add(key);
      }
    }
    if (stopped) {
      // The rest of this section and every later one were not read.
      for (const later of input.sections.slice(position))
        if (applicable(input, later) !== null) skip(later);
      break;
    }
  }
  if (clobbered.size > 0)
    input.notes.add(
      `${String(clobbered.size)} initializer slot(s) are partly overwritten or relocated more than once by section relocations and are listed as unresolved.`,
    );
  return { found, clobbered, complete };
};
