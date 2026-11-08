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
  mappedFileOffset,
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
/** nlist records decoded across every LC_SYMTAB together. */
const SYMBOL_SCAN = 65536;

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
}

const note = (scan: MachoScan, message: string): void => {
  scan.notes.add(message);
  scan.incomplete = true;
};

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

const readSymbols = (
  scan: MachoScan,
  wide: boolean,
  little: boolean,
): Map<bigint, string> => {
  const names = new Map<bigint, string>();
  const header = readMachoLoadCommandTableHeader(scan.bytes, scan.bytes.length);
  if (!header.ok || header.value === null) return names;
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
      return names;
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
      return names;
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
      const observed = observeElfStringTableEntry(
        strings,
        strx,
        MAX_NATIVE_INITIALIZER_NAME_BYTES + 1,
      );
      const text = elfStringTableText(observed);
      if (observed.state === "truncated") {
        scan.notes.tally("long-symbol-name");
        scan.incomplete = true;
        continue;
      }
      if (text === null || text.length === 0 || names.has(value)) continue;
      names.set(value, text);
    }
    if (stopped) {
      note(
        scan,
        `Symbol scanning stopped at ${String(SYMBOL_SCAN)} symbols across all LC_SYMTAB commands. Later names may be missing.`,
      );
      return names;
    }
  }
  return names;
};

const pointerResolution = (
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
      method: "chained_fixup",
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
  readonly base: bigint;
  readonly symbols: ReadonlyMap<bigint, string>;
  readonly sections: ReturnType<typeof indexSections>;
  readonly locate: (address: bigint, size: number) => number | null;
  readonly signal: AbortSignal | undefined;
}

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
        : offsets
          ? {
              method: "offset_table",
              value: walk.base + stored,
              importName: null,
              definedName: null,
            }
          : pointerResolution(walk.fixups, walk.chained, slotVa, stored);
    if (stored !== null && !offsets && applied.method === "unresolved")
      walk.scan.undecoded += 1;
    const symbol =
      applied.method === "unresolved_import"
        ? applied.importName
        : applied.value === null
          ? null
          : (walk.symbols.get(applied.value) ?? null);
    entries.push({
      index: entries.length,
      kind,
      slotVa,
      slotFileOffset: walk.fileBase + slotFile,
      slotBytes: stride === 4 ? 4 : 8,
      valueVa: applied.value,
      valueFileOffset:
        applied.value === null ? null : walk.locate(applied.value, 1),
      slotSection: section.name,
      section:
        applied.value === null
          ? null
          : containing(walk.sections, applied.value),
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
  };
  const cpu = header.value.identity.cpuType >>> 0;
  const decoded = layoutFixups(
    scan,
    container.bits,
    container.byte_order === "little",
    cpu,
  );
  const base = imageBase(container.mappings, decoded.base);
  const symbols = readSymbols(
    scan,
    header.value.wide,
    header.value.littleEndian,
  );
  const locate = (address: bigint, size: number): number | null => {
    try {
      return (
        image.fileBase +
        mappedFileOffset(
          container.mappings,
          address,
          size,
          container.zero_fills,
        )
      );
    } catch (cause) {
      if (cause instanceof BinaryMappingFailure) return null;
      throw cause;
    }
  };
  const walk: SectionWalk = {
    scan,
    image: container,
    fileBase: image.fileBase,
    fixups: decoded.fixups,
    chained: container.macho_chained_fixups === true,
    base,
    symbols,
    sections: indexSections(container.sections),
    locate,
    signal,
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
