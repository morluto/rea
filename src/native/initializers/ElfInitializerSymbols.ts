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

const stringAt = (
  table: Buffer | null,
  offset: number,
  notes: InitializerNotes,
): { readonly name: string | null; readonly truncated: boolean } => {
  if (table === null) return { name: null, truncated: false };
  const observed = observeElfStringTableEntry(
    table,
    offset,
    MAX_NATIVE_INITIALIZER_NAME_BYTES + 1,
  );
  if (observed.state === "truncated") {
    notes.tally("long-symbol-name");
    return { name: null, truncated: true };
  }
  const text = elfStringTableText(observed);
  if (
    text === null ||
    text.length === 0 ||
    text.length > MAX_NATIVE_INITIALIZER_NAME_BYTES
  )
    return { name: null, truncated: false };
  return { name: text, truncated: false };
};

const tableBytes = (
  bytes: Buffer,
  section: NativeSection | undefined,
): Buffer | null => {
  if (section === undefined || !section.file_backed) return null;
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
} => {
  const width = facts.bits === 64 ? 24 : 16;
  const strings = tableBytes(facts.bytes, sections[section.link]);
  const start = Number(section.offset);
  const declared = section.size / BigInt(width);
  const count = Number(declared < BigInt(budget) ? declared : BigInt(budget));
  const truncated = declared > BigInt(budget);
  if (truncated)
    notes.add(
      `Symbol table scanning stopped at ${String(SYMBOL_SCAN)} symbols across all symbol tables. Later names may be missing.`,
    );
  const symbols: ElfInitializerSymbol[] = [];
  let nameTruncated = false;
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
    nameTruncated ||= named.truncated;
    symbols.push({
      name: named.name,
      value: parsed.value.value,
      section: parsed.value.section_index,
      type: parsed.value.type,
    });
  }
  return { symbols, truncated: truncated || nameTruncated };
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
    if (
      !section.file_backed ||
      section.size % BigInt(facts.bits === 64 ? 24 : 16) !== 0n
    ) {
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
  if (entry.type !== absolute) return unresolved();
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

interface SectionRelocInput extends ImageFacts {
  readonly sections: readonly NativeSection[];
  /** ET_REL: `r_offset` is relative to the section named by `sh_info`. */
  readonly relocatable: boolean;
  /** File offsets of slots not covered by dynamic relocations. */
  readonly wanted: ReadonlySet<number>;
  readonly tables: ReadonlyMap<number, readonly ElfInitializerSymbol[]>;
  readonly notes: InitializerNotes;
  readonly fileOffset: (address: bigint) => number | null;
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

const recordTarget = (
  input: SectionRelocInput,
  target: NativeSection | undefined,
  offset: bigint,
): number | null => {
  if (!input.relocatable) return input.fileOffset(offset);
  if (target === undefined || !target.file_backed) return null;
  if (offset < 0n || offset + BigInt(wordOf(input.bits)) > target.size)
    return null;
  return Number(target.offset + offset);
};

/** Section REL/RELA records for slots that dynamic tables do not cover, keyed by slot file offset. */
export const sectionRelocations = (
  input: SectionRelocInput,
): Map<number, SlotRelocation> => {
  const found = new Map<number, SlotRelocation>();
  if (input.wanted.size === 0) return found;
  const word = wordOf(input.bits);
  // One budget across every header, so many headers over one range cannot multiply the work.
  let budget = SECTION_RELOCATION_RECORD_SCAN;
  for (const section of input.sections) {
    const encoding = encodingOf(section.type);
    if (encoding === null || !section.file_backed) continue;
    const width = encoding === "rela" ? word * 3 : word * 2;
    const entsize =
      section.entry_size === 0n ? BigInt(width) : section.entry_size;
    if (entsize !== BigInt(width) || section.size % entsize !== 0n) {
      input.notes.tally("relocation-entry-size");
      continue;
    }
    const symbols = input.tables.get(section.link);
    const target = input.relocatable ? input.sections[section.info] : undefined;
    if (input.relocatable && target === undefined) continue;
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
      if (index % 4096 === 0) assertArtifactReadActive(input.signal);
      const at = start + index * width;
      const parsed = readRelocationRecord(
        input.bytes.subarray(at, at + width),
        input.bits,
        input.little,
        encoding,
      );
      if (!parsed.ok) {
        input.notes.add(parsed.error.message);
        break;
      }
      const slot = recordTarget(input, target, parsed.value.offset);
      if (slot === null || !input.wanted.has(slot)) continue;
      const inplace =
        encoding === "rel"
          ? readPointerWord(input.bytes, slot, input.bits, input.little)
          : null;
      found.set(
        slot,
        relocationFromEntry(input, parsed.value, symbols, inplace),
      );
    }
    if (stopped) break;
  }
  return found;
};
