import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import {
  MachoLoadCommandCursor,
  readMachoLoadCommandTableHeader,
  readMachoSymtabCommand,
} from "../../domain/apple/machoLoadCommands.js";
import {
  elfStringTableText,
  observeElfStringTableEntry,
} from "../../domain/elfStringTable.js";
import {
  MAX_NATIVE_INITIALIZER_ENTRIES,
  MAX_NATIVE_INITIALIZER_NAME_BYTES,
  type NativeInitializerKind,
  type NativeInitializerSlice,
  type NativeInitializerInspection,
} from "../../domain/native/nativeInitializers.js";
import { parsePointerFixups, type PointerFixups } from "../AppleMachoFixups.js";
import { parseMachoLayout } from "../AppleMachoSelection.js";
import {
  BinaryFormatFailure,
  BinaryMappingFailure,
  createFileMappingIndex,
  type ImageSection,
} from "../metadata/BinaryContainer.js";
import { readMachoImage } from "../metadata/MachoImage.js";
import {
  finishInitializerReport,
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
const LC_SYMTAB = 0x2;
const LC_DYSYMTAB = 0xb;
const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
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
  readonly bytes: Buffer;
  readonly notes: InitializerNotes;
  incomplete: boolean;
  /** Pointer slots whose fixup decode returned no rebase, bind or raw value. */
  undecoded: number;
  /** Object-file slots whose section relocation this reader does not apply. */
  unappliedObjectRelocations: number;
}

const note = (scan: MachoScan, message: string): void => {
  scan.notes.add(message);
  scan.incomplete = true;
};

/**
 * dyld fixups for a linked little-endian arm64 or x86-64 image. Other images
 * get null, and {@link uncheckedFixupReason} decides whether their stored
 * words can still be trusted.
 */
const layoutFixups = (
  scan: MachoScan,
  bits: 32 | 64,
  little: boolean,
  cpu: number,
): { readonly fixups: PointerFixups | null; readonly base: bigint | null } => {
  const architecture =
    cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x86_64" : null;
  if (bits !== 64 || !little || architecture === null)
    return { fixups: null, base: null };
  try {
    const layout = parseMachoLayout(scan.bytes, architecture);
    return {
      fixups: parsePointerFixups(
        scan.bytes,
        layout.fixups,
        layout.segments,
        layout.baseAddress,
      ),
      base: layout.baseAddress,
    };
  } catch (cause) {
    note(
      scan,
      cause instanceof Error
        ? cause.message
        : "Mach-O fixups could not be decoded.",
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
  readonly wide: boolean;
  readonly little: boolean;
}

interface MachoSymbols {
  readonly names: ReadonlyMap<bigint, string>;
  readonly table: SymbolTable | null;
}

/** Name at `strx`. Index 0 is the empty name; an index outside the table is unreadable. */
const nameAt = (
  scan: MachoScan,
  strings: Buffer,
  strx: number,
): string | null => {
  if (strx === 0) return null;
  const observed = observeElfStringTableEntry(
    strings,
    strx,
    MAX_NATIVE_INITIALIZER_NAME_BYTES + 1,
  );
  if (observed.state === "truncated") {
    scan.notes.tally("long-symbol-name");
    scan.incomplete = true;
    return null;
  }
  if (observed.state === "outside") {
    scan.notes.tally("unreadable-symbol-name");
    scan.incomplete = true;
    return null;
  }
  const text = elfStringTableText(observed);
  return text === null || text.length === 0 ? null : text;
};

const readSymbols = (
  scan: MachoScan,
  wide: boolean,
  little: boolean,
): MachoSymbols => {
  const names = new Map<bigint, string>();
  let first: SymbolTable | null = null;
  const done = (): MachoSymbols => ({ names, table: first });
  const header = readMachoLoadCommandTableHeader(scan.bytes, scan.bytes.length);
  if (!header.ok || header.value === null) return done();
  const cursor = new MachoLoadCommandCursor(header.value);
  const width = wide ? 16 : 12;
  // One budget across every LC_SYMTAB, so repeated commands cannot multiply the work.
  let budget = SYMBOL_SCAN;
  const seen = new Set<string>();
  while (cursor.nextOffset !== null) {
    const commandAt = header.value.headerSize + cursor.nextOffset;
    const frame = cursor.read(scan.bytes.subarray(commandAt, commandAt + 8));
    if (!frame.ok) break;
    const body = scan.bytes.subarray(commandAt, commandAt + frame.value.size);
    if (frame.value.command !== LC_SYMTAB) continue;
    const table = readMachoSymtabCommand(body, little);
    if (table === null) {
      note(scan, "LC_SYMTAB is truncated.");
      return done();
    }
    const stringsEnd = table.stroff + table.strsize;
    if (
      table.symoff < 0 ||
      table.stroff < 0 ||
      table.strsize < 0 ||
      stringsEnd > scan.bytes.length ||
      table.nsyms > (scan.bytes.length - table.symoff) / width
    ) {
      note(scan, "LC_SYMTAB points outside the Mach-O image.");
      return done();
    }
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
      wide,
      little,
    };
    const count = Math.min(table.nsyms, budget);
    budget -= count;
    const stopped = table.nsyms > count;
    for (let index = 0; index < count; index += 1) {
      const at = table.symoff + index * width;
      const type = scan.bytes[at + 4] ?? 0;
      // Skip debugger stabs and undefined (N_UNDF) entries.
      if ((type & 0xe0) !== 0 || (type & 0x0e) === 0) continue;
      const strx = little
        ? scan.bytes.readUInt32LE(at)
        : scan.bytes.readUInt32BE(at);
      const value = wide
        ? little
          ? scan.bytes.readBigUInt64LE(at + 8)
          : scan.bytes.readBigUInt64BE(at + 8)
        : BigInt(
            little
              ? scan.bytes.readUInt32LE(at + 8)
              : scan.bytes.readUInt32BE(at + 8),
          );
      const text = nameAt(scan, strings, strx);
      if (text === null || names.has(value)) continue;
      names.set(value, text);
    }
    if (stopped) {
      note(
        scan,
        `Symbol scanning stopped at ${String(SYMBOL_SCAN)} symbols across all LC_SYMTAB commands. Later names may be missing.`,
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
  little: boolean,
  decoded: boolean,
): string | null => {
  const header = readMachoLoadCommandTableHeader(scan.bytes, scan.bytes.length);
  if (!header.ok || header.value === null) return null;
  const cursor = new MachoLoadCommandCursor(header.value);
  const word = (at: number): number =>
    at + 4 > scan.bytes.length
      ? 0
      : little
        ? scan.bytes.readUInt32LE(at)
        : scan.bytes.readUInt32BE(at);
  while (cursor.nextOffset !== null) {
    const commandAt = header.value.headerSize + cursor.nextOffset;
    const frame = cursor.read(scan.bytes.subarray(commandAt, commandAt + 8));
    if (!frame.ok) break;
    const { command, size } = frame.value;
    if (
      !decoded &&
      (command === LC_DYLD_INFO || command === LC_DYLD_INFO_ONLY) &&
      size >= 48 &&
      // bind_size, weak_bind_size and lazy_bind_size.
      (word(commandAt + 20) !== 0 ||
        word(commandAt + 28) !== 0 ||
        word(commandAt + 36) !== 0)
    )
      return "LC_DYLD_INFO bind opcodes are not decoded for this image, so a pointer slot's stored word may be replaced by a bound symbol at load time.";
    // nextrel: legacy external relocations, which no decoder here applies.
    if (command === LC_DYSYMTAB && size >= 80 && word(commandAt + 68) !== 0)
      return "LC_DYSYMTAB external relocations are not decoded, so a pointer slot's stored word may be replaced by a bound symbol at load time.";
  }
  return null;
};

const pointerResolution = (
  fixups: PointerFixups | null,
  chained: boolean,
  unchecked: boolean,
  address: bigint,
  raw: bigint,
): SlotRelocation => {
  const resolved = decodePointer(fixups, chained, address, raw);
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
  if (decoded.kind === "bind")
    return {
      method: "unresolved_import",
      value: null,
      importName:
        decoded.symbol.length > 0 &&
        decoded.symbol.length <= MAX_NATIVE_INITIALIZER_NAME_BYTES
          ? decoded.symbol
          : null,
      definedName: null,
    };
  return {
    method: "unresolved",
    value: null,
    importName: null,
    definedName: null,
  };
};

const readWord = (
  bytes: Buffer,
  offset: number,
  width: number,
  little: boolean,
): bigint | null => {
  if (offset < 0 || offset > bytes.length - width) return null;
  if (width === 8)
    return little
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);
  return BigInt(
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset),
  );
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
    );
    return { bySlot, complete: false };
  }
  const read = Math.min(count, walk.relocationBudget);
  walk.relocationBudget -= read;
  if (read < count)
    note(
      walk.scan,
      `Object-file relocation scanning stopped at ${String(SECTION_RELOCATION_SCAN)} entries. Slots past that point are listed as unresolved.`,
    );
  const little = walk.image.byte_order === "little";
  const length = stride === 8 ? 3 : 2;
  const add = (address: number, relocation: ObjectRelocation): void => {
    const slot = address - (address % stride);
    const exact = address === slot && relocation.kind === "unsigned";
    bySlot.set(
      slot,
      exact && !bySlot.has(slot) ? relocation : { kind: "other" },
    );
  };
  for (let index = 0; index < read; index += 1) {
    if (index % 4096 === 0) assertArtifactReadActive(walk.signal);
    const at = offset + index * 8;
    const first = little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
    const info = little
      ? bytes.readUInt32LE(at + 4)
      : bytes.readUInt32BE(at + 4);
    // R_SCATTERED: the low 24 bits hold the address in either byte order.
    if ((first & 0x80000000) !== 0) {
      add(first & 0xffffff, { kind: "other" });
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
  const width = table.wide ? 16 : 12;
  const at = table.symoff + index * width;
  const bytes = walk.scan.bytes;
  if (at + width > bytes.length) return UNRESOLVED;
  const strx = table.little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  const type = bytes[at + 4] ?? 0;
  const value = table.wide
    ? table.little
      ? bytes.readBigUInt64LE(at + 8)
      : bytes.readBigUInt64BE(at + 8)
    : BigInt(
        table.little ? bytes.readUInt32LE(at + 8) : bytes.readUInt32BE(at + 8),
      );
  // Debugger stabs never name a relocation target.
  if ((type & 0xe0) !== 0) return UNRESOLVED;
  const name = nameAt(walk.scan, table.strings, strx);
  // N_UNDF: defined in another object or library.
  if ((type & 0x0e) === 0)
    return {
      method: "unresolved_import",
      value: null,
      importName: name,
      definedName: null,
    };
  // Only N_SECT has an address in this object.
  if ((type & 0x0e) !== 0x0e) return UNRESOLVED;
  return {
    method: "symbol_addend",
    value: BigInt.asUintN(walk.image.bits, value + stored),
    importName: null,
    definedName: stored === 0n ? name : null,
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

const slotsOf = (
  walk: SectionWalk,
  section: Extract<ImageSection, { format: "macho" }>,
  kind: NativeInitializerKind,
  detail: string,
  offsets: boolean,
  entries: CollectedInitializer[],
): boolean => {
  const stride = offsets ? 4 : walk.image.bits / 8;
  if (!section.file_backed) {
    note(
      walk.scan,
      `${section.name} is not file-backed. Its slots were omitted.`,
    );
    return false;
  }
  if (section.size % stride !== 0)
    note(
      walk.scan,
      `${section.name} size is not a multiple of its slot width. Trailing bytes were not read.`,
    );
  const count = Math.floor(section.size / stride);
  const little = walk.image.byte_order === "little";
  const relocations = walk.object
    ? objectRelocations(walk, section, stride)
    : undefined;
  for (let index = 0; index < count; index += 1) {
    if (entries.length >= MAX_NATIVE_INITIALIZER_ENTRIES) return true;
    if (entries.length % 1024 === 0) assertArtifactReadActive(walk.signal);
    const slotVa = section.address + BigInt(index * stride);
    const slotFile = section.offset + index * stride;
    const stored = readWord(walk.scan.bytes, slotFile, stride, little);
    const unresolved: SlotRelocation = {
      method: "unresolved",
      value: null,
      importName: null,
      definedName: null,
    };
    const applied: SlotRelocation =
      stored === null
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
        : (applied.definedName ??
          (applied.value === null
            ? null
            : (walk.symbols.names.get(applied.value) ??
              (code === null ? null : walk.symbols.names.get(code)) ??
              null)));
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
export const readMachoInitializers = (
  image: MachoInitializerImage,
  page: InitializerPage,
  signal?: AbortSignal,
): NativeInitializerInspection => {
  assertArtifactReadActive(signal);
  const container = readMachoImage(image.bytes);
  const header = readMachoLoadCommandTableHeader(
    image.bytes,
    image.bytes.length,
  );
  if (!header.ok || header.value === null)
    throw new BinaryFormatFailure("malformed", "Unrecognized Mach-O header");
  const scan: MachoScan = {
    bytes: image.bytes,
    notes: new InitializerNotes(),
    incomplete: false,
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
  const little = container.byte_order === "little";
  // Object files carry section relocations, not dyld fixups.
  const object = header.value.fileType === MH_OBJECT;
  const decoded = object
    ? { fixups: null, base: null }
    : layoutFixups(scan, container.bits, little, cpu);
  const unchecked = object
    ? null
    : uncheckedFixupReason(scan, little, decoded.fixups !== null);
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
      stopped = slotsOf(
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
    );
  // decode() records failures lazily, so sample them only after every slot was decoded.
  if (
    container.macho_chained_fixups === true &&
    (decoded.fixups === null || decoded.fixups.failures.length > 0)
  )
    note(scan, "Mach-O chained fixup coverage is incomplete.");
  if (unchecked !== null && scan.undecoded > 0) note(scan, unchecked);
  if (scan.unappliedObjectRelocations > 0)
    note(
      scan,
      `${String(scan.unappliedObjectRelocations)} object-file slot(s) have section relocations this reader does not apply and are listed as unresolved.`,
    );
  if (scan.undecoded > 0)
    note(
      scan,
      `${String(scan.undecoded)} pointer slot(s) could not be decoded through Mach-O fixups and are listed as unresolved.`,
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
    scan.incomplete,
  );
};
