import { readInitializerWord } from "./initializerWord.js";
import { LC } from "../../domain/apple/machoLoadCommandCodes.js";
import { setImmediate as immediate } from "node:timers/promises";
import { assertArtifactReadActive } from "../../resources/index.js";
import {
  admitMachoSymtabRanges,
  MachoLoadCommandCursor,
  readMachoLoadCommandTableHeader,
  readMachoSymtabCommand,
} from "../../domain/apple/machoLoadCommands.js";
import { observeElfStringTableEntry } from "../../domain/elfStringTable.js";
import {
  MAX_NATIVE_INITIALIZER_ENTRIES,
  MAX_NATIVE_INITIALIZER_NAME_BYTES,
  type NativeInitializerKind,
  type NativeInitializerSlice,
  type NativeInitializerInspection,
} from "../../domain/native/nativeInitializers.js";
import {
  parsePointerFixupsSteps,
  type PointerFixups,
} from "../../domain/apple/appleMachoFixups.js";
import { parseMachoLayout } from "../../domain/apple/appleMachoSelection.js";
import { selectMachoSlice } from "../../domain/apple/machoSliceSelection.js";
import { decodeMachoName } from "../../domain/apple/appleMachoNames.js";
import {
  BinaryFormatFailure,
  BinaryMappingFailure,
  BinaryReader,
  createFileMappingIndex,
  type ImageSection,
} from "../../domain/binaryContainer.js";
import { readMachoImage } from "../../domain/apple/machoImage.js";
import {
  joinCoverageStatus,
  type CoverageStatus,
} from "../../domain/coverage.js";
import {
  finishInitializerReport,
  preferInitializerSymbolName,
  withheldInitializerSymbolName,
  type InitializerSymbolName,
  type CollectedInitializer,
  type InitializerPage,
} from "./initializerReport.js";
import { InitializerNotes } from "./initializerNotes.js";
import {
  buildAddressRangeIndex,
  type AddressRangeIndex,
} from "./addressRangeIndex.js";
import type { SlotRelocation } from "./ElfInitializerSymbols.js";

const S_MOD_INIT_FUNC_POINTERS = 0x9;
const S_MOD_TERM_FUNC_POINTERS = 0xa;
const S_INIT_FUNC_OFFSETS = 0x16;
const MH_OBJECT = 0x1;
const CPU_TYPE_ARM = 12;
const CPU_TYPE_ARM64_32 = 0x0200000c;
/** nlist records decoded across every LC_SYMTAB together. */
const SYMBOL_SCAN = 65536;
/** Object-file section relocation entries read across every initializer section together. */
const SECTION_RELOCATION_SCAN = 1_048_576;

const CPU_ARCHITECTURE = new Map<
  number,
  NonNullable<NativeInitializerInspection["architecture"]>
>([
  [7, "x86"],
  [0x01000007, "x86_64"],
  [12, "arm"],
  [0x0100000c, "arm64"],
  [0x0200000c, "arm64_32"],
]);

/** Thin slice plus its location in the container file. */
export interface MachoInitializerImage {
  readonly bytes: Buffer;
  readonly fileBase: number;
  readonly slice: NativeInitializerSlice | null;
}

interface MachoScan {
  readonly reader: BinaryReader;
  readonly bytes: Buffer;
  readonly notes: InitializerNotes;
  /** Known gaps (`partial`) and undetermined facts (`unknown`) noted so far. */
  coverage: CoverageStatus;
  /** Pointer slots whose fixup decode returned no rebase, bind or raw value. */
  undecoded: number;
  /** Object-file slots whose section relocation this reader does not apply. */
  unappliedObjectRelocations: number;
}

/** Widen coverage: `partial` for a known gap, `unknown` when it cannot be determined. */
const widen = (scan: MachoScan, effect: "partial" | "unknown"): void => {
  scan.coverage = joinCoverageStatus([scan.coverage, effect]);
};

const note = (
  scan: MachoScan,
  message: string,
  effect: "partial" | "unknown",
): void => {
  scan.notes.add(message);
  widen(scan, effect);
};

/**
 * dyld fixups for a linked little-endian arm64 or x86-64 image. Other images
 * get null, and {@link uncheckedFixupReason} decides whether their stored
 * words can still be trusted.
 */
const layoutFixups = async (
  scan: MachoScan,
  bits: 32 | 64,
  little: boolean,
  cpu: number,
  signal?: AbortSignal,
): Promise<{
  readonly fixups: PointerFixups | null;
  readonly base: bigint | null;
}> => {
  const architecture =
    cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x86_64" : null;
  if (bits !== 64 || !little || architecture === null)
    return { fixups: null, base: null };
  // The architecture is the scanned header's own, so the thin image is
  // selected whole; a refusal is noted like any other undecoded fixup.
  const selected = selectMachoSlice(scan.bytes, {
    mode: "admitted",
    architecture,
    slice: undefined,
  });
  if (!selected.ok) {
    note(scan, selected.error.message, "unknown");
    return { fixups: null, base: null };
  }
  try {
    const layout = parseMachoLayout(scan.bytes, selected.value);
    const steps = parsePointerFixupsSteps(
      scan.bytes,
      layout.fixups,
      layout.segments,
      layout.baseAddress,
    );
    let next = steps.next();
    while (!next.done) {
      await immediate();
      assertArtifactReadActive(signal);
      next = steps.next();
    }
    return { fixups: next.value, base: layout.baseAddress };
  } catch (cause) {
    assertArtifactReadActive(signal);
    note(
      scan,
      cause instanceof Error
        ? cause.message
        : "Mach-O fixups could not be decoded.",
      "unknown",
    );
    return { fixups: null, base: null };
  }
};

const imageBase = (
  mappings: ReturnType<typeof readMachoImage>["mappings"],
  layoutBase: bigint | null,
): bigint => {
  const zero = mappings.find((mapping) => mapping.offset === 0);
  if (zero !== undefined) return zero.address;
  const first = mappings[0];
  if (first === undefined) return layoutBase ?? 0n;
  return mappings.reduce(
    (lowest, mapping) => (mapping.address < lowest ? mapping.address : lowest),
    first.address,
  );
};

type MachoSection = Extract<ImageSection, { format: "macho" }>;

/** Smallest section containing an address; earlier sections win ties. Built once per image. */
const indexSections = (
  sections: readonly ImageSection[],
): AddressRangeIndex<{
  readonly section: MachoSection;
  readonly order: number;
}> =>
  buildAddressRangeIndex(
    sections.flatMap((section, order) =>
      section.format === "macho" && section.size !== 0
        ? [
            {
              start: section.address,
              end: section.address + BigInt(section.size),
              value: { section, order },
            },
          ]
        : [],
    ),
    (left, right) =>
      left.section.size - right.section.size || left.order - right.order,
  );

const containing = (
  index: ReturnType<typeof indexSections>,
  address: bigint,
): string | null => {
  const name = index.at(address)?.value.section.name;
  return name === undefined || name.length === 0 ? null : name;
};

/** The first admitted LC_SYMTAB, which object-file relocations index by symbol number. */
interface SymbolTable {
  readonly symoff: number;
  readonly nsyms: number;
  readonly strings: Buffer;
  readonly width: 12 | 16;
}

interface MachoSymbols {
  readonly names: ReadonlyMap<bigint, InitializerSymbolName>;
  readonly table: SymbolTable | null;
}

/**
 * Name at `strx`. Index 0 is the empty name; an index outside the table is
 * unreadable, which leaves coverage unknown. A name exceeding the byte
 * budget stays marked until a collected entry uses it.
 */
const nameAt = (
  scan: MachoScan,
  strings: Buffer,
  strx: number,
): InitializerSymbolName | null => {
  if (strx === 0) return null;
  const observed = observeElfStringTableEntry(
    strings,
    strx,
    MAX_NATIVE_INITIALIZER_NAME_BYTES + 1,
  );
  if (observed.state === "truncated") {
    // The table's last NUL establishes a terminator beyond the name window.
    if (strings.at(-1) === 0) {
      scan.notes.tally("long-symbol-name");
      return withheldInitializerSymbolName;
    }
    scan.notes.tally("unverified-symbol-terminator");
    widen(scan, "unknown");
    return null;
  }
  if (observed.state === "outside") {
    scan.notes.tally("unreadable-symbol-name");
    widen(scan, "unknown");
    return null;
  }
  const text = decodeMachoName(observed.bytes);
  if (typeof text !== "string") {
    scan.notes.tally("unreadable-symbol-name");
    widen(scan, "unknown");
    return null;
  }
  return text.length === 0 ? null : text;
};

const readSymbols = (
  scan: MachoScan,
  wide: boolean,
  little: boolean,
): MachoSymbols => {
  const names = new Map<bigint, InitializerSymbolName>();
  let first: SymbolTable | null = null;
  const done = (): MachoSymbols => ({ names, table: first });
  const header = readMachoLoadCommandTableHeader(scan.bytes, scan.bytes.length);
  if (!header.ok || header.value === null) return done();
  const cursor = new MachoLoadCommandCursor(header.value);
  // One budget across every LC_SYMTAB, so repeated commands cannot multiply the work.
  let budget = SYMBOL_SCAN;
  const seen = new Set<string>();
  while (cursor.nextOffset !== null) {
    const commandAt = header.value.headerSize + cursor.nextOffset;
    const frame = cursor.read(scan.bytes.subarray(commandAt, commandAt + 8));
    if (!frame.ok) break;
    const body = scan.bytes.subarray(commandAt, commandAt + frame.value.size);
    if (frame.value.command !== LC.SYMTAB) continue;
    const table = readMachoSymtabCommand(body, little);
    if (table === null) {
      note(scan, "LC_SYMTAB is truncated.", "unknown");
      return done();
    }
    const ranges = admitMachoSymtabRanges(table, wide, scan.bytes.length);
    if (ranges === null) {
      note(scan, "LC_SYMTAB points outside the Mach-O image.", "unknown");
      return done();
    }
    const { width, stringsEnd } = ranges;
    const range = `${String(table.symoff)}:${String(table.nsyms)}:${String(table.stroff)}:${String(table.strsize)}`;
    if (seen.has(range)) {
      // Nothing is lost by skipping an identical copy, so coverage stays as it was.
      scan.notes.add(
        "A repeated LC_SYMTAB names the same symbol and string ranges and was ignored.",
      );
      continue;
    }
    seen.add(range);
    const strings = scan.bytes.subarray(table.stroff, stringsEnd);
    first ??= {
      symoff: table.symoff,
      nsyms: table.nsyms,
      strings,
      width,
    };
    const count = Math.min(table.nsyms, budget);
    budget -= count;
    const stopped = table.nsyms > count;
    for (let index = 0; index < count; index += 1) {
      const at = table.symoff + index * width;
      const type = scan.reader.u8(at + 4);
      // Only N_ABS and N_SECT carry addresses. N_INDR's n_value is a string
      // table index, and N_PBUD is still undefined in this image.
      const kind = type & 0x0e;
      if ((type & 0xe0) !== 0 || (kind !== 0x02 && kind !== 0x0e)) continue;
      const strx = scan.reader.u32(at);
      const value = scan.reader.word(at + 8, wide ? 64 : 32);
      const text = nameAt(scan, strings, strx);
      if (text === null) continue;
      const previous = names.get(value);
      if (
        previous === undefined ||
        (previous === withheldInitializerSymbolName && typeof text === "string")
      )
        names.set(value, text);
    }
    if (stopped) {
      note(
        scan,
        `Symbol scanning stopped at ${String(SYMBOL_SCAN)} symbols across all LC_SYMTAB commands. Later names may be missing.`,
        "unknown",
      );
      return done();
    }
  }
  return done();
};

/**
 * Why a stored pointer word in a linked image cannot be trusted when no fixup
 * decoder covers it, or null when it can. Rebases keep the link-time target in
 * the stored word, so only bind streams and external relocations replace it.
 */
const uncheckedFixupReason = (
  scan: MachoScan,
  decoded: boolean,
): string | null => {
  const header = readMachoLoadCommandTableHeader(scan.bytes, scan.bytes.length);
  if (!header.ok || header.value === null) return null;
  const cursor = new MachoLoadCommandCursor(header.value);
  const word = (at: number): number =>
    at + 4 > scan.bytes.length ? 0 : scan.reader.u32(at);
  while (cursor.nextOffset !== null) {
    const commandAt = header.value.headerSize + cursor.nextOffset;
    const frame = cursor.read(scan.bytes.subarray(commandAt, commandAt + 8));
    if (!frame.ok) break;
    const { command, size } = frame.value;
    if (
      !decoded &&
      (command === LC.DYLD_INFO || command === LC.DYLD_INFO_ONLY) &&
      size >= 48 &&
      // bind_size, weak_bind_size and lazy_bind_size.
      (word(commandAt + 20) !== 0 ||
        word(commandAt + 28) !== 0 ||
        word(commandAt + 36) !== 0)
    )
      return "LC_DYLD_INFO bind opcodes are not decoded for this image, so a pointer slot's stored word may be replaced by a bound symbol at load time.";
    // nextrel: legacy external relocations, which no decoder here applies.
    if (command === LC.DYSYMTAB && size >= 80 && word(commandAt + 68) !== 0)
      return "LC_DYSYMTAB external relocations are not decoded, so a pointer slot's stored word may be replaced by a bound symbol at load time.";
  }
  return null;
};

const pointerResolution = (
  scan: MachoScan,
  fixups: PointerFixups | null,
  chained: boolean,
  unchecked: boolean,
  address: bigint,
  raw: bigint,
): SlotRelocation => {
  const resolved = decodePointer(scan, fixups, chained, address, raw);
  // A stored word is only the target when every fixup source over it was checked.
  return unchecked && resolved.method === "raw" ? UNRESOLVED : resolved;
};

const UNRESOLVED: SlotRelocation = {
  method: "unresolved",
  value: null,
  importName: null,
  definedName: null,
};

const decodePointer = (
  scan: MachoScan,
  fixups: PointerFixups | null,
  chained: boolean,
  address: bigint,
  raw: bigint,
): SlotRelocation => {
  // Without a chained-fixup decoder, a chained slot's stored word is an encoding, not an address.
  if (fixups === null && chained)
    return {
      method: "unresolved",
      value: null,
      importName: null,
      definedName: null,
    };
  if (fixups === null)
    return { method: "raw", value: raw, importName: null, definedName: null };
  const decoded = fixups.decode(address, raw);
  if (decoded.kind === "rebase")
    return {
      // The decoder reports both encodings as rebases; its kind names the source.
      method: fixups.kind === "chained" ? "chained_fixup" : "dyld_info_rebase",
      value: decoded.target,
      importName: null,
      definedName: null,
    };
  if (decoded.kind === "raw")
    return {
      method: "raw",
      value: decoded.target,
      importName: null,
      definedName: null,
    };
  if (decoded.kind === "bind") {
    // The bound name is the only identity of this target, so dropping it is a visible gap.
    const overBudget =
      decoded.symbol.length > MAX_NATIVE_INITIALIZER_NAME_BYTES;
    if (overBudget) {
      // This entry's own import name is withheld: a known gap.
      scan.notes.tally("long-symbol-name");
      widen(scan, "partial");
    }
    return {
      method: "unresolved_import",
      value: null,
      importName:
        decoded.symbol.length > 0 && !overBudget ? decoded.symbol : null,
      definedName: null,
    };
  }
  note(scan, decoded.reason, "unknown");
  return {
    method: "unresolved",
    value: null,
    importName: null,
    definedName: null,
  };
};

interface SectionWalk {
  readonly scan: MachoScan;
  readonly image: ReturnType<typeof readMachoImage>;
  readonly fileBase: number;
  readonly fixups: PointerFixups | null;
  readonly chained: boolean;
  /** A fixup source over pointer slots was not decoded, so a stored word is not a target. */
  readonly unchecked: boolean;
  /** MH_OBJECT: section relocation entries, not dyld fixups, set slot values. */
  readonly object: boolean;
  /** CPU_TYPE_ARM: function pointers may carry the Thumb bit. */
  readonly thumb: boolean;
  readonly base: bigint;
  readonly symbols: MachoSymbols;
  readonly sections: ReturnType<typeof indexSections>;
  readonly locate: (address: bigint, size: number) => number | null;
  readonly signal: AbortSignal | undefined;
  /** Object-file relocation entries still readable across every section. */
  relocationBudget: number;
}

/** One object-file relocation entry as it bears on the slot it starts in. */
type ObjectRelocation =
  | {
      readonly kind: "unsigned";
      readonly extern: boolean;
      readonly symbol: number;
    }
  | { readonly kind: "other" };

interface ObjectRelocations {
  /** Keyed by slot offset inside the section. */
  readonly bySlot: ReadonlyMap<number, ObjectRelocation>;
  /** False when some entries were not read, so an unmatched slot may still be relocated. */
  readonly complete: boolean;
}

/**
 * Read an object file section's own relocation entries. Only a pointer-width,
 * non-PC-relative UNSIGNED (or VANILLA) entry that starts a slot is applied;
 * every other entry over a slot leaves it unresolved.
 */
const objectRelocations = (
  walk: SectionWalk,
  section: MachoSection,
  stride: number,
): ObjectRelocations => {
  const { offset, count } = section.relocations;
  const bySlot = new Map<number, ObjectRelocation>();
  if (count === 0) return { bySlot, complete: true };
  const bytes = walk.scan.bytes;
  if (offset < 0 || count > (bytes.length - offset) / 8) {
    note(
      walk.scan,
      `${section.name} relocation entries lie outside the file, so its slots are listed as unresolved.`,
      "unknown",
    );
    return { bySlot, complete: false };
  }
  const read = Math.min(count, walk.relocationBudget);
  walk.relocationBudget -= read;
  if (read < count)
    note(
      walk.scan,
      `Object-file relocation scanning stopped at ${String(SECTION_RELOCATION_SCAN)} entries. Slots past that point are listed as unresolved.`,
      "unknown",
    );
  const little = walk.image.byte_order === "little";
  const length = stride === 8 ? 3 : 2;
  const add = (
    address: number,
    width: number,
    relocation: ObjectRelocation,
  ): void => {
    const firstSlot = address - (address % stride);
    const end = address + width;
    for (let slot = firstSlot; slot < end; slot += stride) {
      const exact =
        address === slot && width === stride && relocation.kind === "unsigned";
      bySlot.set(
        slot,
        exact && !bySlot.has(slot) ? relocation : { kind: "other" },
      );
    }
  };
  for (let index = 0; index < read; index += 1) {
    if (index % 4096 === 0) assertArtifactReadActive(walk.signal);
    const at = offset + index * 8;
    const first = walk.scan.reader.u32(at);
    const info = walk.scan.reader.u32(at + 4);
    // R_SCATTERED: the low 24 bits hold the address in either byte order.
    if ((first & 0x80000000) !== 0) {
      add(first & 0xffffff, 1 << ((first >>> 28) & 3), { kind: "other" });
      continue;
    }
    const fields = little
      ? {
          symbol: info & 0xffffff,
          pcrel: (info >>> 24) & 1,
          length: (info >>> 25) & 3,
          extern: (info >>> 27) & 1,
          type: info >>> 28,
        }
      : {
          symbol: info >>> 8,
          pcrel: (info >>> 7) & 1,
          length: (info >>> 5) & 3,
          extern: (info >>> 4) & 1,
          type: info & 0xf,
        };
    add(
      first,
      1 << fields.length,
      fields.type === 0 && fields.pcrel === 0 && fields.length === length
        ? {
            kind: "unsigned",
            extern: fields.extern === 1,
            symbol: fields.symbol,
          }
        : { kind: "other" },
    );
  }
  return { bySlot, complete: read === count };
};

/** `S + A` for an external UNSIGNED entry against nlist `index`. */
const objectSymbol = (
  walk: SectionWalk,
  index: number,
  stored: bigint,
): SlotRelocation => {
  const table = walk.symbols.table;
  if (table === null || index >= table.nsyms) return UNRESOLVED;
  const { width } = table;
  const at = table.symoff + index * width;
  const { reader, bytes } = walk.scan;
  if (at + width > bytes.length) return UNRESOLVED;
  const strx = reader.u32(at);
  const type = reader.u8(at + 4);
  const value = reader.word(at + 8, width === 16 ? 64 : 32);
  // Debugger stabs never name a relocation target.
  if ((type & 0xe0) !== 0) return UNRESOLVED;
  const ownName = () => nameAt(walk.scan, table.strings, strx);
  // N_UNDF: defined in another object or library.
  if ((type & 0x0e) === 0)
    return {
      method: "unresolved_import",
      value: null,
      importName: ownName(),
      definedName: null,
    };
  // Only N_SECT has an address in this object.
  if ((type & 0x0e) !== 0x0e) return UNRESOLVED;
  return {
    method: "symbol_addend",
    value: BigInt.asUintN(walk.image.bits, value + stored),
    importName: null,
    // A nonzero addend points past the symbol, so its name is not reported.
    definedName: stored === 0n ? ownName() : null,
  };
};

/** One object-file slot, which only its section relocation entries can change. */
const objectSlot = (
  walk: SectionWalk,
  relocations: ObjectRelocations,
  slotOffset: number,
  stored: bigint,
  offsets: boolean,
): SlotRelocation => {
  const relocation = relocations.bySlot.get(slotOffset);
  const unchanged: SlotRelocation = offsets
    ? {
        method: "offset_table",
        value: walk.base + stored,
        importName: null,
        definedName: null,
      }
    : { method: "raw", value: stored, importName: null, definedName: null };
  if (relocation === undefined)
    return relocations.complete ? unchanged : UNRESOLVED;
  if (relocation.kind === "other" || offsets) return UNRESOLVED;
  // A section-ordinal entry keeps the stored object-space address as the target.
  if (!relocation.extern) return unchanged;
  return objectSymbol(walk, relocation.symbol, stored);
};

const slotsOf = async (
  walk: SectionWalk,
  section: Extract<ImageSection, { format: "macho" }>,
  kind: NativeInitializerKind,
  detail: string,
  offsets: boolean,
  entries: CollectedInitializer[],
): Promise<boolean> => {
  const bits = offsets ? 32 : walk.image.bits;
  const stride = bits / 8;
  if (!section.file_backed) {
    note(
      walk.scan,
      `${section.name} is not file-backed. Its slots were omitted.`,
      "partial",
    );
    return false;
  }
  if (section.size % stride !== 0)
    note(
      walk.scan,
      `${section.name} size is not a multiple of its slot width. Trailing bytes were not read.`,
      "partial",
    );
  const count = Math.floor(section.size / stride);
  const relocations = walk.object
    ? objectRelocations(walk, section, stride)
    : undefined;
  for (let index = 0; index < count; index += 1) {
    if (entries.length >= MAX_NATIVE_INITIALIZER_ENTRIES) return true;
    if (index % 128 === 0) {
      await immediate();
      assertArtifactReadActive(walk.signal);
    }
    const slotVa = section.address + BigInt(index * stride);
    const slotFile = section.offset + index * stride;
    const stored = readInitializerWord(walk.scan.reader, slotFile, bits);
    const mappingMismatch =
      !walk.object && walk.locate(slotVa, stride) !== walk.fileBase + slotFile;
    if (mappingMismatch)
      note(
        walk.scan,
        `${section.name} slot mapping disagrees with its section offset; affected slots are unresolved.`,
        "unknown",
      );
    const unresolved: SlotRelocation = {
      method: "unresolved",
      value: null,
      importName: null,
      definedName: null,
    };
    const applied: SlotRelocation =
      stored === null || mappingMismatch
        ? unresolved
        : relocations !== undefined
          ? objectSlot(walk, relocations, index * stride, stored, offsets)
          : offsets
            ? {
                method: "offset_table",
                value: walk.base + stored,
                importName: null,
                definedName: null,
              }
            : pointerResolution(
                walk.scan,
                walk.fixups,
                walk.chained,
                walk.unchecked,
                slotVa,
                stored,
              );
    if (stored !== null && applied.method === "unresolved") {
      if (relocations !== undefined) walk.scan.unappliedObjectRelocations += 1;
      else if (!offsets) walk.scan.undecoded += 1;
    }
    // 32-bit ARM: bit 0 selects Thumb state, so it is cleared to find the code.
    const code =
      applied.value === null
        ? null
        : walk.thumb
          ? applied.value & ~1n
          : applied.value;
    const symbol =
      applied.method === "unresolved_import"
        ? applied.importName
        : typeof applied.definedName === "string" || applied.value === null
          ? applied.definedName
          : preferInitializerSymbolName(
              applied.definedName,
              preferInitializerSymbolName(
                walk.symbols.names.get(applied.value),
                code === null ? null : walk.symbols.names.get(code),
              ),
            );
    entries.push({
      index: entries.length,
      kind,
      slotVa,
      slotFileOffset: walk.fileBase + slotFile,
      slotBytes: stride === 4 ? 4 : 8,
      valueVa: applied.value,
      valueFileOffset: code === null ? null : walk.locate(code, 1),
      slotSection: section.name,
      section: code === null ? null : containing(walk.sections, code),
      symbol,
      resolution: applied.method,
      detail,
    });
  }
  return false;
};

const SECTIONS = [
  {
    type: S_MOD_INIT_FUNC_POINTERS,
    kind: "mod_init",
    detail: "S_MOD_INIT_FUNC_POINTERS",
    offsets: false,
  },
  {
    type: S_INIT_FUNC_OFFSETS,
    kind: "init_offsets",
    detail: "S_INIT_FUNC_OFFSETS",
    offsets: true,
  },
  {
    type: S_MOD_TERM_FUNC_POINTERS,
    kind: "mod_term",
    detail: "S_MOD_TERM_FUNC_POINTERS",
    offsets: false,
  },
] as const;

/** Decode Mach-O initializer and finalizer slots for one selected thin slice. */
export const readMachoInitializers = async (
  image: MachoInitializerImage,
  page: InitializerPage,
  signal?: AbortSignal,
): Promise<NativeInitializerInspection> => {
  assertArtifactReadActive(signal);
  const container = readMachoImage(image.bytes);
  const header = readMachoLoadCommandTableHeader(
    image.bytes,
    image.bytes.length,
  );
  if (!header.ok || header.value === null)
    throw new BinaryFormatFailure("malformed", "Unrecognized Mach-O header");
  const little = container.byte_order === "little";
  const scan: MachoScan = {
    reader: new BinaryReader(image.bytes, little, "macho"),
    bytes: image.bytes,
    notes: new InitializerNotes(),
    coverage: "complete",
    undecoded: 0,
    unappliedObjectRelocations: 0,
  };
  const cpu = header.value.identity.cpuType >>> 0;
  // arm64_32 pointers are four bytes, so slot width cannot follow a 64-bit header.
  if (cpu === CPU_TYPE_ARM64_32 && container.bits === 64)
    throw new BinaryFormatFailure(
      "malformed",
      "arm64_32 Mach-O uses 4-byte pointers but declares a 64-bit header",
    );
  // Object files carry section relocations, not dyld fixups.
  const object = header.value.fileType === MH_OBJECT;
  const decoded = object
    ? { fixups: null, base: null }
    : await layoutFixups(scan, container.bits, little, cpu, signal);
  const unchecked = object
    ? null
    : uncheckedFixupReason(scan, decoded.fixups !== null);
  const base = imageBase(container.mappings, decoded.base);
  const symbols = readSymbols(
    scan,
    header.value.wide,
    header.value.littleEndian,
  );
  // Built once per image, so each slot and target lookup is logarithmic.
  const mappings = createFileMappingIndex(
    container.mappings,
    container.zero_fills,
  );
  const locate = (address: bigint, size: number): number | null => {
    try {
      return image.fileBase + mappings.offset(address, size);
    } catch (cause) {
      if (!(cause instanceof BinaryMappingFailure)) throw cause;
      if (cause.reason === "ambiguous")
        note(
          scan,
          "An address has ambiguous file mappings (overlapping load segments with different file offsets, or file and zero-fill memory), so its file offset is not reported.",
          "unknown",
        );
      return null;
    }
  };
  const walk: SectionWalk = {
    scan,
    image: container,
    fileBase: image.fileBase,
    fixups: decoded.fixups,
    chained: container.macho_chained_fixups === true,
    unchecked: unchecked !== null,
    object,
    thumb: cpu === CPU_TYPE_ARM,
    base,
    symbols,
    sections: indexSections(container.sections),
    locate,
    signal,
    relocationBudget: SECTION_RELOCATION_SCAN,
  };
  const entries: CollectedInitializer[] = [];
  let stopped = false;
  for (const spec of SECTIONS) {
    for (const section of container.sections) {
      if (section.format !== "macho" || section.type !== spec.type) continue;
      stopped = await slotsOf(
        walk,
        section,
        spec.kind,
        spec.detail,
        spec.offsets,
        entries,
      );
      if (stopped) break;
    }
    if (stopped) break;
  }
  if (stopped)
    note(
      scan,
      "Initializer scanning stopped at 65536 slots. Later slots were not read.",
      "partial",
    );
  // decode() records failures lazily, so sample them only after every slot was decoded.
  if (
    container.macho_chained_fixups === true &&
    (decoded.fixups === null || decoded.fixups.failures.length > 0)
  )
    note(scan, "Mach-O chained fixup coverage is incomplete.", "unknown");
  if (unchecked !== null && scan.undecoded > 0)
    note(scan, unchecked, "unknown");
  if (scan.unappliedObjectRelocations > 0)
    note(
      scan,
      `${String(scan.unappliedObjectRelocations)} object-file slot(s) have section relocations this reader does not apply and are listed as unresolved.`,
      "unknown",
    );
  if (scan.undecoded > 0)
    note(
      scan,
      `${String(scan.undecoded)} pointer slot(s) could not be decoded through Mach-O fixups and are listed as unresolved.`,
      "unknown",
    );
  return finishInitializerReport(
    {
      format: "mach-o",
      architecture: CPU_ARCHITECTURE.get(cpu) ?? null,
      bits: container.bits,
      byte_order: container.byte_order,
      machine: cpu,
      elf_type: null,
      slice: image.slice,
    },
    entries,
    // Mach-O omits no slot it reads, so every read slot is an entry.
    entries.length,
    scan.notes,
    page,
    scan.coverage,
  );
};
