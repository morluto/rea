import { admitElfLoadSegment } from "../../domain/elfProgramHeader.js";
import { BinaryReader } from "../../domain/binaryContainer.js";
import { readLeb128, SLEB64, ULEB64 } from "../../domain/leb128.js";
import {
  allKeyed,
  keyedBy,
  uniqueKeyed,
} from "../../domain/keyedCollection.js";
import {
  ArtifactReaderFailure,
  assertArtifactReadActive,
  yieldArtifactRead,
} from "../../resources/index.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { walkElfDynamicTable } from "../../domain/elfDynamicEntry.js";
import {
  elfSymbolSize,
  readElfSymbolFieldsAt,
  readElfSymbolValueAt,
} from "../../domain/elfSymbol.js";
import {
  elfStringTableText,
  observeElfStringTableEntry,
  type ElfStringTableObservation,
} from "../../domain/elfStringTable.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
  ELF_UNWIND_LIMITATIONS,
  elfEhPointerEncodingName,
  MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES,
  MAX_ELF_UNWIND_SYMBOLS,
  type ElfUnwindLimitationCode,
  type ElfUnwindRanges,
  type InspectElfUnwindRangesInput,
} from "../../domain/native/elfUnwindRanges.js";
import { buildIntervalIndex } from "./ElfIntervalIndex.js";
import {
  ELF_PT_GNU_EH_FRAME,
  readElfDirectoryFromReader,
  type ElfProgramDeclaration,
  type ElfSectionDirectory,
  type NativeSection,
} from "../../domain/native/nativeSectionDirectory.js";
import type { ByteSource } from "../../domain/byteSource.js";

const DW_EH_PE_OMIT = 0xff;
/** CIE augmentation letters, compared as bytes. */
const AUG_Z = 0x7a;
const AUG_L = 0x4c;
const AUG_P = 0x50;
const AUG_R = 0x52;
const AUG_S = 0x53;
const AUG_B = 0x42;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const SHT_NOBITS = 8;
const SHT_DYNSYM = 11;
const DT_PLTGOT = 3n;
/** Bound on dynamic entries scanned for DT_PLTGOT. */
const MAX_DYNAMIC_ENTRIES = 4096;
const STT_NOTYPE = 0;
const STT_FUNC = 2;
const STT_GNU_IFUNC = 10;
const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;
const SHN_LORESERVE = 0xff00;
const EM_ARM = 40;
const SHF_ALLOC = 2n;
const SHF_EXECINSTR = 4n;

const {
  cfa: CFA_LIMITATION,
  untrusted: UNTRUSTED_LIMITATION,
  indirect: INDIRECT_LIMITATION,
  headerMismatch: HEADER_MISMATCH,
  frameAbsent: FRAME_ABSENT,
  headerAbsent: HEADER_ABSENT,
  debugPresent: DEBUG_PRESENT,
  debugAbsent: DEBUG_ABSENT,
  debugUnknown: DEBUG_UNKNOWN,
  debugOutside: DEBUG_OUTSIDE,
} = ELF_UNWIND_LIMITATIONS;
const DATAREL_UNRESOLVED =
  "A DW_EH_PE_datarel .eh_frame value needs a GOT base that could not be determined; that value is unresolved.";

/** Counted note for FDEs skipped because their initial location is zero. */
const discardedLimitation = (count: number): string =>
  count === 1
    ? "1 FDE has a zero initial location and was skipped as a discarded entry."
    : `${String(count)} FDEs have a zero initial location and were skipped as discarded entries.`;

const TABLE_BOUNDED =
  "The .eh_frame located only through the .eh_frame_hdr eh_frame_ptr has no section bounds and no terminator after the last FDE its search table names; bytes after that FDE were not decoded.";
const UNBOUNDED_STOPPED =
  "The .eh_frame located only through the .eh_frame_hdr eh_frame_ptr has no section bounds or usable search table, so decoding stopped at the first record that failed to decode.";
const UNBOUNDED_UNTERMINATED =
  "The .eh_frame located only through the .eh_frame_hdr eh_frame_ptr has no section bounds, usable search table or terminator before the end of its PT_LOAD segment, so its extent is unknown.";

/** Counted note for FDEs skipped because their initial location is indirect. */
const indirectFdeLimitation = (count: number): string =>
  count === 1
    ? "1 FDE has an indirect initial location that was not dereferenced; its function start is unknown and it was skipped."
    : `${String(count)} FDEs have indirect initial locations that were not dereferenced; their function starts are unknown and they were skipped.`;
const INDIRECT_COUNT =
  "The .eh_frame_hdr FDE count uses an indirect encoding that was not dereferenced, so the count and search table are unknown.";
const IFUNC_NAMES =
  "A symbol name from an STT_GNU_IFUNC symbol names the resolver that starts at that address, not the implementation it selects at run time.";
const INDIRECT_TABLE =
  "The .eh_frame_hdr search table uses an indirect encoding that was not dereferenced; it was not compared with the decoded FDEs.";
const INDIRECT_FRAME_POINTER =
  "The .eh_frame_hdr eh_frame_ptr is indirect and was not dereferenced, so it does not locate .eh_frame.";

const POINTER_MISMATCH =
  "The .eh_frame_hdr eh_frame_ptr does not match the .eh_frame section address.";
const UNKNOWN_AUGMENTATION =
  "A CIE augmentation has an unrecognized letter, so its pointer encodings cannot be trusted; that CIE was not decoded.";

/** Counted note for FDEs skipped because their CIE has an unknown augmentation. */
const unknownAugmentationLimitation = (count: number): string =>
  count === 1
    ? "1 FDE uses a CIE with an unrecognized augmentation letter and was not decoded."
    : `${String(count)} FDEs use a CIE with an unrecognized augmentation letter and were not decoded.`;

interface FileRange {
  readonly offset: number;
  readonly bytes: number;
}

interface Encoding {
  readonly raw: number;
  readonly name: string;
}

interface Personality {
  readonly address: string;
  readonly encoding: Encoding;
  readonly indirect: boolean;
}

interface CieRecord {
  readonly index: number;
  readonly version: 1 | 3;
  /** Augmentation bytes before their NUL, decoded only for returned CIEs. */
  readonly augmentation: Buffer;
  readonly code_alignment: number;
  readonly data_alignment: number;
  readonly return_address_register: number;
  readonly pointer_encoding: Encoding;
  readonly lsda_encoding: Encoding | null;
  readonly personality: Personality | null;
  readonly signal_frame: boolean;
  readonly b_key: boolean;
  readonly instruction_bytes: number;
  readonly location: FileRange;
  readonly hasZ: boolean;
}

interface DecodedRange {
  readonly index: number;
  readonly cie_index: number;
  readonly lsda: {
    readonly addressValue: bigint;
    readonly indirect: boolean;
  } | null;
  readonly personality: {
    readonly address: string;
    readonly indirect: boolean;
  } | null;
  readonly location: FileRange;
  readonly startValue: bigint;
  readonly sizeValue: bigint;
}

interface HeaderRow {
  readonly startValue: bigint;
  readonly fdeFileOffset: number | null;
}

interface HeaderDecode {
  readonly status: "present" | "absent" | "incomplete" | "unknown";
  readonly location: FileRange | null;
  readonly version: number | null;
  readonly eh_frame_pointer_encoding: Encoding | null;
  readonly fde_count_encoding: Encoding | null;
  readonly table_encoding: Encoding | null;
  readonly eh_frame_pointer: string | null;
  readonly ehFramePointer: bigint | null;
  readonly fde_count: number | null;
  readonly table_entries: number;
  readonly rows: readonly HeaderRow[];
  readonly decoded: boolean;
}

interface DecodedPointer {
  readonly address: bigint;
  readonly indirect: boolean;
  readonly next: number;
}

interface PointerBases {
  /** `.eh_frame_hdr` fields use the header address; `.eh_frame` uses the GOT. */
  readonly datarel: bigint | null;
  readonly textrel: bigint | null;
  readonly funcrel: bigint | null;
  readonly lengthOnly: boolean;
}

type ReadEncoded = (
  offset: number,
  end: number,
  encoding: number,
  bases: PointerBases,
) => DecodedPointer | "omit" | null;

/**
 * Where a section's declared bytes sit in the file. A range that runs past the
 * end of file is clamped to the in-file prefix; NOBITS or wholly outside
 * sections have no file range.
 */
interface SectionPlacement {
  readonly location: FileRange | null;
  readonly problem: "nobits" | "outside" | "clamped" | null;
}

const placeSection = (
  section: NativeSection,
  fileBytes: number,
): SectionPlacement => {
  if (section.type === SHT_NOBITS) return { location: null, problem: "nobits" };
  const declared = fileRange(section);
  if (declared === null || declared.offset > fileBytes)
    return { location: null, problem: "outside" };
  if (declared.bytes > fileBytes - declared.offset)
    return {
      location: {
        offset: declared.offset,
        bytes: fileBytes - declared.offset,
      },
      problem: "clamped",
    };
  return { location: declared, problem: null };
};

export const ELF_UNWIND_FORMAT = "elf-unwind-ranges";
export const ELF_UNWIND_RECORD_LIMIT = "max_ranges";
const OPERATION = "inspect_elf_unwind_ranges";
const STREAM_WINDOW_BYTES = 65536;
/** Maximum bytes one DW_EH_PE value can occupy (8-byte alignment + 8-byte value, or 10-byte LEB). */
const MAX_ENCODED_POINTER_BYTES = 16;
/** Maximum bytes before the .eh_frame_hdr binary search table (4 + 2 * 16 + margin). */
const MAX_EH_FRAME_HDR_PREFIX_BYTES = 48;

interface ReadStep {
  readonly offset: number;
  readonly length: number;
}

function* readSlice(
  offset: number,
  length: number,
): Generator<ReadStep, Buffer, Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  return yield { offset, length };
}

/** Read unwind ranges over a bounded file handle. Truncation stays incomplete. */
export const parseElfUnwindRangesFromHandle = async (
  source: ByteSource,
  artifact: ElfUnwindRanges["artifact"],
  input: InspectElfUnwindRangesInput,
  signal?: AbortSignal,
): Promise<ElfUnwindRanges> => {
  assertArtifactReadActive(signal);
  const directory = await readElfDirectoryFromReader(
    source,
    () => yieldArtifactRead(signal),
    OPERATION,
    { structureBytes: input.max_structure_bytes },
  );
  const steps = elfUnwindRangesSteps(
    source.size,
    artifact,
    input,
    directory,
    signal,
  );
  let next = steps.next();
  while (!next.done) {
    assertArtifactReadActive(signal);
    const { offset, length } = next.value;
    const slice =
      source.prefix !== undefined && offset + length <= source.prefix.length
        ? source.prefix.subarray(offset, offset + length)
        : await source.readRange(offset, length);
    if (slice.length !== length)
      throw new ArtifactReaderFailure(
        "integrity",
        "ELF unwind range ended before its admitted file extent.",
        { integrityCheck: "read-coverage" },
      );
    next = steps.next(slice);
  }
  return next.value;
};

interface SliceAccessors {
  readonly readU8: (offset: number, end: number) => number | null;
  readonly readU32: (offset: number, end: number) => number | null;
  readonly readU64: (offset: number, end: number) => bigint | null;
  readonly readLeb: (
    offset: number,
    end: number,
    signed: boolean,
  ) => { readonly value: bigint; readonly next: number } | null;
  readonly readEncoded: ReadEncoded;
  readonly findNul: (start: number, end: number) => number;
  readonly subarray: (start: number, end: number) => Buffer;
}

function* elfUnwindRangesSteps(
  fileBytes: number,
  artifact: ElfUnwindRanges["artifact"],
  input: InspectElfUnwindRangesInput,
  directory: ElfSectionDirectory,
  signal?: AbortSignal,
): Generator<ReadStep, ElfUnwindRanges, Buffer> {
  assertArtifactReadActive(signal);
  const little = directory.little;
  const bits = directory.bits;
  const addressSize = bits === 64 ? 8 : 4;
  const limitationCodes: ElfUnwindLimitationCode[] = [];
  const limitations: string[] = [];
  let incomplete = false;
  let sawIndirect = false;
  const noteCode = (code: ElfUnwindLimitationCode): void => {
    if (!limitationCodes.includes(code)) limitationCodes.push(code);
  };
  const note = (text: string, code?: ElfUnwindLimitationCode): void => {
    if (!limitations.includes(text)) limitations.push(text);
    if (code !== undefined) noteCode(code);
  };
  const fail = (text: string, code?: ElfUnwindLimitationCode): void => {
    incomplete = true;
    note(text, code);
  };

  // Without section headers, sections outside every segment stay unknown.
  const namesKnown =
    directory.sections.length > 0 &&
    directory.section_names_limitation === undefined &&
    directory.sections.every((section) => section.name_state === "known");
  if (directory.section_names_limitation !== undefined) {
    fail(directory.section_names_limitation);
  }

  // The section directory has already admitted every program header,
  // including a PN_XNUM count, or rejected the image.
  const loads = directory.programs.flatMap((program) => {
    if (program.type !== 1) return [];
    const admitted = admitElfLoadSegment(
      {
        virtualAddress: program.virtual_address,
        memorySize: program.memory_size,
        fileSize: program.file_size,
      },
      directory.bits,
    );
    if (
      !admitted.ok ||
      program.file_offset + program.file_size > BigInt(fileBytes)
    ) {
      fail(
        "An invalid PT_LOAD mapping was excluded from unwind address resolution.",
      );
      return [];
    }
    return [programSpan(program)];
  });
  const gnuHeaders = directory.programs.flatMap((program) =>
    program.type === ELF_PT_GNU_EH_FRAME ? [programSpan(program)] : [],
  );
  const gnu = gnuHeaders[0];

  const byName = keyedBy(directory.sections, ({ name }) => name);
  const named = (name: string): readonly NativeSection[] =>
    allKeyed(byName, name);
  const ehSections = named(".eh_frame");
  const hdrSections = named(".eh_frame_hdr");
  const debugSections = named(".debug_frame");
  // Ranges in ignored duplicate tables are omitted, so coverage is incomplete.
  if (ehSections.length > 1)
    fail(
      "Multiple .eh_frame sections were declared; only the first was decoded.",
    );
  if (hdrSections.length > 1)
    fail(
      "Multiple .eh_frame_hdr sections were declared; only the first was decoded.",
    );
  // Only the first PT_GNU_EH_FRAME is read. Its duplicates matter only when
  // no .eh_frame_hdr section supplies the header instead.
  if (gnuHeaders.length > 1 && hdrSections.length === 0)
    fail(
      "Multiple PT_GNU_EH_FRAME program headers were declared; only the first was decoded.",
    );

  const debugSection = debugSections[0];
  const debugPlacement =
    debugSection === undefined ? null : placeSection(debugSection, fileBytes);
  let debugFrame: ElfUnwindRanges["debug_frame"];
  if (debugPlacement === null)
    debugFrame = {
      status: namesKnown ? "absent" : "unknown",
      location: null,
    };
  else if (debugPlacement.problem === null)
    debugFrame = { status: "present", location: debugPlacement.location };
  else {
    debugFrame = { status: "incomplete", location: null };
    fail(DEBUG_OUTSIDE, "debug_frame_outside_file");
  }

  // In-file bytes of each SHF_ALLOC section; a section running past EOF keeps
  // its prefix. A non-ALLOC section's sh_addr is not a load address, so
  // translation falls through to PT_LOAD for bytes no ALLOC section maps.
  const mapped = directory.sections.flatMap((section) => {
    if ((section.flags & SHF_ALLOC) === 0n) return [];
    const location = placeSection(section, fileBytes).location;
    return location === null || location.bytes === 0
      ? []
      : [{ section, size: BigInt(location.bytes) }];
  });
  // Overlaps resolve once per image: the smallest section, then the lowest
  // index. Each lookup is then a binary search.
  const sectionAtFileOffset = buildIntervalIndex(
    mapped.map(({ section, size }) => ({
      low: section.offset,
      high: section.offset + size,
      value: section,
    })),
    (left, right) => {
      if (left.size !== right.size) return left.size < right.size ? -1 : 1;
      return left.index - right.index;
    },
  );
  // The first mapped section in directory order owns an address.
  const sectionAtAddress = buildIntervalIndex(
    mapped.map(({ section, size }, order) => ({
      low: section.address,
      high: section.address + size,
      value: { section, order },
    })),
    (left, right) => left.order - right.order,
  );
  // PT_LOAD fallbacks are indexed once too; the first segment in program
  // header order owns an overlapping byte or address.
  const loadAtFileOffset = buildIntervalIndex(
    loads.map((load, order) => ({
      low: load.offset,
      high: load.offset + load.fileSize,
      value: { load, order },
    })),
    (left, right) => left.order - right.order,
  );
  const loadAtAddress = buildIntervalIndex(
    loads.map((load, order) => ({
      low: load.virtualAddress,
      high: load.virtualAddress + load.fileSize,
      value: { load, order },
    })),
    (left, right) => left.order - right.order,
  );
  const vaForFileOffset = (fileOff: number): bigint | null => {
    const off = BigInt(fileOff);
    const chosen = sectionAtFileOffset(off);
    if (chosen !== undefined) return chosen.address + (off - chosen.offset);
    const load = loadAtFileOffset(off)?.load;
    return load === undefined
      ? null
      : load.virtualAddress + (off - load.offset);
  };
  const fileOffsetForVa = (address: bigint): number | null => {
    const owner = sectionAtAddress(address)?.section;
    if (owner !== undefined) {
      const file = owner.offset + (address - owner.address);
      if (file < 0n || file > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return Number(file);
    }
    const load = loadAtAddress(address)?.load;
    if (load === undefined) return null;
    const file = load.offset + (address - load.virtualAddress);
    if (file < 0n || file > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(file);
  };
  // DW_EH_PE_textrel base, resolved once per image.
  const textBaseAddress: bigint | null =
    loads.find((load) => (load.flags & 1) !== 0)?.virtualAddress ??
    named(".text").find((section) => (section.flags & SHF_ALLOC) !== 0n)
      ?.address ??
    null;

  const within = (offset: number, size: number): boolean =>
    offset >= 0 &&
    size >= 0 &&
    offset <= fileBytes &&
    size <= fileBytes - offset;
  const safeInt = (value: bigint): number | null =>
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;

  let datarelMissing = false;
  let datarelUsed = false;
  const createSliceAccessors = (
    slice: Buffer,
    baseOffset: number,
  ): SliceAccessors => {
    const reader = new BinaryReader(slice, little, "elf");
    const sliceEnd = baseOffset + slice.length;
    const fieldFits = (offset: number, size: number, end: number): boolean =>
      offset >= baseOffset &&
      size >= 0 &&
      offset + size <= end &&
      offset + size <= sliceEnd &&
      within(offset, size);
    const readU8 = (offset: number, end: number): number | null =>
      fieldFits(offset, 1, end) ? (slice[offset - baseOffset] ?? null) : null;
    const readU32 = (offset: number, end: number): number | null =>
      fieldFits(offset, 4, end) ? reader.u32(offset - baseOffset) : null;
    const readU64 = (offset: number, end: number): bigint | null =>
      fieldFits(offset, 8, end) ? reader.word(offset - baseOffset, 64) : null;
    const readS16 = (offset: number, end: number): number | null =>
      fieldFits(offset, 2, end) ? reader.i16(offset - baseOffset) : null;
    const readU16 = (offset: number, end: number): number | null =>
      fieldFits(offset, 2, end) ? reader.u16(offset - baseOffset) : null;
    const readS32 = (offset: number, end: number): number | null =>
      fieldFits(offset, 4, end) ? reader.i32(offset - baseOffset) : null;
    const readS64 = (offset: number, end: number): bigint | null =>
      fieldFits(offset, 8, end) ? reader.i64(offset - baseOffset) : null;
    const readLeb = (
      offset: number,
      end: number,
      signed: boolean,
    ): { readonly value: bigint; readonly next: number } | null => {
      const localOffset = offset - baseOffset;
      const localEnd = Math.min(end, sliceEnd) - baseOffset;
      if (localOffset < 0 || localOffset > localEnd) return null;
      const read = readLeb128(
        slice,
        localOffset,
        localEnd,
        signed ? SLEB64 : ULEB64,
      );
      return "failure" in read
        ? null
        : { value: read.value, next: read.next + baseOffset };
    };
    const readEncoded: ReadEncoded = (offset, end, encoding, bases) => {
      if ((encoding & 0xff) === 0xff) return "omit";
      if (encoding === 0x50) {
        const field = vaForFileOffset(offset);
        if (field === null) return null;
        const align = BigInt(addressSize);
        const aligned = (field + align - 1n) & ~(align - 1n);
        const file = offset + Number(aligned - field);
        const width = addressSize;
        const raw = width === 8 ? readU64(file, end) : readU32(file, end);
        if (raw === null) return null;
        return {
          address: typeof raw === "bigint" ? raw : BigInt(raw),
          indirect: false,
          next: file + width,
        };
      }
      const format = encoding & 0x0f;
      let raw: bigint | null = null;
      let next = offset;
      switch (format) {
        case 0: {
          const value =
            addressSize === 8 ? readU64(offset, end) : readU32(offset, end);
          if (value === null) return null;
          raw = typeof value === "bigint" ? value : BigInt(value);
          next = offset + addressSize;
          break;
        }
        case 1: {
          const value = readLeb(offset, end, false);
          if (value === null) return null;
          raw = value.value;
          next = value.next;
          break;
        }
        case 2: {
          const value = readU16(offset, end);
          if (value === null) return null;
          raw = BigInt(value);
          next = offset + 2;
          break;
        }
        case 3: {
          const value = readU32(offset, end);
          if (value === null) return null;
          raw = BigInt(value);
          next = offset + 4;
          break;
        }
        case 4: {
          const value = readU64(offset, end);
          if (value === null) return null;
          raw = value;
          next = offset + 8;
          break;
        }
        case 9: {
          const value = readLeb(offset, end, true);
          if (value === null) return null;
          raw = value.value;
          next = value.next;
          break;
        }
        case 0x0a: {
          const value = readS16(offset, end);
          if (value === null) return null;
          raw = BigInt(value);
          next = offset + 2;
          break;
        }
        case 0x0b: {
          const value = readS32(offset, end);
          if (value === null) return null;
          raw = BigInt(value);
          next = offset + 4;
          break;
        }
        case 0x0c: {
          const value = readS64(offset, end);
          if (value === null) return null;
          raw = value;
          next = offset + 8;
          break;
        }
        default:
          return null;
      }
      if (bases.lengthOnly) return { address: raw, indirect: false, next };
      // libgcc reads a raw zero as a null pointer: no base is added and an
      // indirect pointer is not followed.
      if (raw === 0n) return { address: 0n, indirect: false, next };
      const application = encoding & 0x70;
      let address = raw;
      if (application === 0x10) {
        const field = vaForFileOffset(offset);
        if (field === null) return null;
        address += field;
      } else if (application === 0x20) {
        if (bases.textrel === null) return null;
        address += bases.textrel;
      } else if (application === 0x30) {
        if (bases.datarel === null) {
          datarelMissing = true;
          return null;
        }
        datarelUsed = true;
        address += bases.datarel;
      } else if (application === 0x40) {
        if (bases.funcrel === null) return null;
        address += bases.funcrel;
      } else if (application !== 0) return null;
      // libgcc computes in _Unwind_Ptr, so a resolved address wraps at the ELF
      // address width.
      address = BigInt.asUintN(bits, address);
      const indirect = (encoding & 0x80) !== 0;
      if (indirect) sawIndirect = true;
      return { address, indirect, next };
    };
    const findNul = (start: number, end: number): number => {
      const localStart = Math.max(0, start - baseOffset);
      const localEnd = Math.min(slice.length, end - baseOffset);
      if (localStart >= localEnd) return -1;
      return slice.subarray(localStart, localEnd).indexOf(0);
    };
    const subarray = (start: number, end: number): Buffer => {
      const localStart = Math.max(0, start - baseOffset);
      const localEnd = Math.min(slice.length, end - baseOffset);
      return localStart >= localEnd
        ? Buffer.alloc(0)
        : slice.subarray(localStart, localEnd);
    };
    return {
      readU8,
      readU32,
      readU64,
      readLeb,
      readEncoded,
      findNul,
      subarray,
    };
  };

  const encodingOf = (raw: number): Encoding => ({
    raw: raw & 0xff,
    name: elfEhPointerEncodingName(raw),
  });
  const hex = (value: bigint): string => `0x${value.toString(16)}`;

  // DW_EH_PE_datarel in .eh_frame_hdr is relative to the header itself.
  let hdrBase: bigint | null = null;
  const hdrSection = hdrSections[0];
  let headerLocation: FileRange | null = null;
  let headerStatus: HeaderDecode["status"] = "absent";
  if (hdrSection !== undefined) {
    const placement = placeSection(hdrSection, fileBytes);
    if (placement.problem !== null) {
      headerStatus = "incomplete";
      fail(
        placement.problem === "nobits"
          ? ".eh_frame_hdr is declared but not file-backed."
          : ".eh_frame_hdr extends past the end of the file and was not decoded.",
      );
    } else if (hdrSection.compressed) {
      headerLocation = placement.location;
      headerStatus = "incomplete";
      fail(".eh_frame_hdr is SHF_COMPRESSED and was not decompressed.");
    } else {
      headerLocation = placement.location;
      headerStatus = "present";
      hdrBase =
        headerLocation === null ? null : vaForFileOffset(headerLocation.offset);
    }
  } else if (gnu !== undefined) {
    const offset = safeInt(gnu.offset);
    const size = safeInt(gnu.fileSize);
    if (
      offset === null ||
      size === null ||
      !within(offset, size) ||
      size > 0xffffffff
    ) {
      headerStatus = "incomplete";
      fail("PT_GNU_EH_FRAME is outside the file.");
    } else {
      headerLocation = { offset, bytes: size };
      headerStatus = "present";
      hdrBase = vaForFileOffset(offset);
    }
  } else if (!namesKnown) headerStatus = "unknown";
  else headerStatus = "absent";

  let header: HeaderDecode;
  if (headerStatus === "present" && headerLocation !== null) {
    const hdrReadBytes = Math.min(
      headerLocation.bytes,
      MAX_EH_FRAME_HDR_PREFIX_BYTES +
        input.max_ranges * 2 * MAX_ENCODED_POINTER_BYTES,
    );
    const hdrSlice = yield* readSlice(headerLocation.offset, hdrReadBytes);
    const hdrAccess = createSliceAccessors(hdrSlice, headerLocation.offset);
    header = decodeHeader(
      headerLocation,
      hdrBase,
      textBaseAddress,
      hdrAccess.readEncoded,
      hdrAccess.readU8,
      safeInt,
      hex,
      fileOffsetForVa,
      fail,
      signal,
      { maxRows: input.max_ranges, addressSize },
    );
  } else {
    header = emptyHeader(headerStatus, headerLocation);
  }

  const ehSection = ehSections[0];
  let frameStatus: ElfUnwindRanges["eh_frame"]["status"] = "absent";
  let frameSource: "section" | "program" | null = null;
  let frameLocation: FileRange | null = null;
  let frameEnd = 0;
  let scanPastTerminator = false;
  let frameClamped = false;
  // File offset of the last FDE the search table names, bounding an
  // .eh_frame that only the header locates.
  let tableBound: number | null = null;
  if (ehSection !== undefined) {
    frameSource = "section";
    const placement = placeSection(ehSection, fileBytes);
    frameLocation = placement.location;
    if (placement.problem === "nobits") {
      frameStatus = "incomplete";
      fail(".eh_frame is declared but not file-backed.");
    } else if (frameLocation === null) {
      frameStatus = "incomplete";
      fail(".eh_frame lies outside the file.");
    } else if (ehSection.compressed) {
      frameStatus = "incomplete";
      fail(".eh_frame is SHF_COMPRESSED and was not decompressed.");
    } else {
      frameStatus = "present";
      frameEnd = frameLocation.offset + frameLocation.bytes;
      // A clamped section's declared tail is missing, so bytes after the
      // terminator are not judged against it.
      frameClamped = placement.problem === "clamped";
      scanPastTerminator = !frameClamped;
      if (frameClamped)
        fail(
          ".eh_frame extends past the end of the file; only its in-file bytes were decoded.",
        );
    }
  } else if (header.ehFramePointer !== null) {
    const start = fileOffsetForVa(header.ehFramePointer);
    const load = loads.find((item) => {
      if (start === null) return false;
      const off = BigInt(start);
      return off >= item.offset && off < item.offset + item.fileSize;
    });
    if (start === null || load === undefined) {
      frameStatus = "incomplete";
      frameSource = "program";
      fail("The .eh_frame_hdr eh_frame_ptr does not map into a file range.");
    } else {
      const end = safeInt(load.offset + load.fileSize);
      frameStatus = "present";
      frameSource = "program";
      frameEnd = Math.min(end ?? fileBytes, fileBytes);
      frameLocation = {
        offset: start,
        bytes: Math.max(0, frameEnd - start),
      };
      scanPastTerminator = false;
      // Without a section, the segment end is not the table end: other data
      // such as .gcc_except_table can follow an unterminated .eh_frame.
      // libgcc's PT_GNU_EH_FRAME lookup only binary-searches this table, so
      // nothing past the last FDE it names is reachable through it.
      if (header.decoded)
        for (const row of header.rows) {
          const at = row.fdeFileOffset;
          if (at !== null && at >= start && at < frameEnd)
            tableBound = Math.max(tableBound ?? at, at);
        }
    }
  } else if (header.status !== "absent" && header.status !== "unknown") {
    frameStatus = "unknown";
    fail(
      "No .eh_frame section was found and the .eh_frame_hdr eh_frame_ptr could not be decoded, so .eh_frame presence is unknown.",
    );
  } else if (!namesKnown) {
    frameStatus = "unknown";
    fail(
      "Section names are unknown and no .eh_frame section or mapped PT_GNU_EH_FRAME target was found, so .eh_frame presence is unknown.",
    );
  } else {
    frameStatus = "absent";
    note(FRAME_ABSENT, "eh_frame_absent");
  }

  // The header is decoded from the .eh_frame_hdr section when one exists, so
  // a PT_GNU_EH_FRAME naming different bytes is the one that was not read.
  if (
    hdrSection !== undefined &&
    gnu !== undefined &&
    headerLocation !== null &&
    (gnu.offset !== BigInt(headerLocation.offset) ||
      gnu.fileSize !== BigInt(headerLocation.bytes))
  ) {
    note(
      "PT_GNU_EH_FRAME names different bytes than the .eh_frame_hdr section; it was ignored because the section is present.",
    );
  }

  // DW_EH_PE_datarel in .eh_frame is GOT-relative (LSB; i386/x86-64 psABI).
  const gotBase = yield* resolveGotBase(fileBytes, directory);
  datarelMissing = false;
  datarelUsed = false;

  const cies: CieRecord[] = [];
  const ranges: DecodedRange[] = [];
  const cieAt = new Map<number, CieRecord>();
  const rejectedCies = new Set<number>();
  const fdeBases: PointerBases = {
    datarel: gotBase?.address ?? null,
    textrel: textBaseAddress,
    funcrel: null,
    lengthOnly: false,
  };
  const fdeLengthBases: PointerBases = {
    datarel: gotBase?.address ?? null,
    textrel: textBaseAddress,
    funcrel: null,
    lengthOnly: true,
  };
  let rejectedFdes = 0;
  let examined = 0;
  let cieRecords = 0;
  let fdeRecords = 0;
  let discarded = 0;
  let indirectFdes = 0;
  const budget = (kind: "CIE" | "FDE", offset: number): never => {
    throw decodeLimit(
      ELF_UNWIND_FORMAT,
      `ELF unwind ${kind} count exceeds the selected max_ranges budget of ${String(input.max_ranges)}.`,
      { name: ELF_UNWIND_RECORD_LIMIT, maximum: input.max_ranges },
      { field: kind, offset },
    );
  };

  if (frameStatus === "present" && frameLocation !== null) {
    let cursor = frameLocation.offset;
    const extent = frameEnd;
    let winBuf: Buffer = Buffer.alloc(0);
    let winBase = 0;
    let winAccess = createSliceAccessors(winBuf, 0);
    function* ensureFrameWindow(
      offset: number,
      minBytes: number,
    ): Generator<ReadStep, void, Buffer> {
      const available = Math.min(minBytes, extent - offset);
      if (offset >= winBase && offset + available <= winBase + winBuf.length)
        return;
      const readLen = Math.min(
        Math.max(STREAM_WINDOW_BYTES, available),
        extent - offset,
      );
      winBuf = yield* readSlice(offset, readLen);
      winBase = offset;
      winAccess = createSliceAccessors(winBuf, winBase);
    }
    // An unbounded header-located table stops at its first undecodable
    // record, as libgcc's linear FDE search does, instead of reading on.
    const stopAtBadRecord = frameSource === "program" && tableBound === null;
    let terminated = false;
    while (cursor < extent) {
      assertArtifactReadActive(signal);
      if (cursor + 4 > extent) {
        fail(".eh_frame ended inside a record.");
        frameStatus = "incomplete";
        break;
      }
      yield* ensureFrameWindow(cursor, 12);
      const initialLength = winAccess.readU32(cursor, extent);
      if (initialLength === null) {
        fail(".eh_frame ended inside a record.");
        frameStatus = "incomplete";
        break;
      }
      if (initialLength === 0) {
        if (scanPastTerminator) {
          let at = cursor + 4;
          let nonZero = false;
          while (at < extent && !nonZero) {
            assertArtifactReadActive(signal);
            const chunkLen = Math.min(STREAM_WINDOW_BYTES, extent - at);
            const chunk =
              at >= winBase && at + chunkLen <= winBase + winBuf.length
                ? winBuf.subarray(at - winBase, at - winBase + chunkLen)
                : yield* readSlice(at, chunkLen);
            for (let i = 0; i < chunk.length; i += 1) {
              if (chunk[i] !== 0) {
                nonZero = true;
                break;
              }
            }
            at += chunk.length;
          }
          if (nonZero) fail("Non-zero bytes follow the .eh_frame terminator.");
        }
        cursor += 4;
        terminated = true;
        break;
      }
      if (tableBound !== null && cursor > tableBound) {
        note(TABLE_BOUNDED);
        terminated = true;
        break;
      }
      let body = cursor + 4;
      let recordEnd = body + initialLength;
      // .eh_frame keeps a 4-byte CIE ID / CIE pointer even after a 64-bit
      // extended length (LSB, libunwind, LLVM IsEH); only .debug_frame's DWARF
      // 64-bit format widens that field, and .debug_frame is not decoded here.
      const idWidth = 4;
      if (initialLength === 0xffffffff) {
        const extended = winAccess.readU64(cursor + 4, extent);
        if (extended === null || extended > BigInt(Number.MAX_SAFE_INTEGER)) {
          fail(".eh_frame ended inside a record.");
          frameStatus = "incomplete";
          break;
        }
        body = cursor + 12;
        recordEnd = body + Number(extended);
      }
      if (recordEnd > extent || recordEnd < body) {
        fail(".eh_frame ended inside a record.");
        frameStatus = "incomplete";
        break;
      }
      const recordStart = cursor;
      yield* ensureFrameWindow(
        recordStart,
        Math.min(recordEnd - recordStart, STREAM_WINDOW_BYTES),
      );
      const id = winAccess.readU32(body, recordEnd);
      if (id === null) {
        fail(".eh_frame ended inside a record.");
        frameStatus = "incomplete";
        break;
      }
      const isCie = id === 0;
      if (isCie) {
        if (cieRecords + 1 > input.max_ranges) budget("CIE", recordStart);
        cieRecords += 1;
      } else if (fdeRecords + 1 > input.max_ranges) budget("FDE", recordStart);
      else fdeRecords += 1;
      examined += 1;
      let undecoded = false;
      if (isCie) {
        if (
          recordEnd > winBase + winBuf.length &&
          winAccess.findNul(body + idWidth + 1, recordEnd) < 0
        ) {
          yield* ensureFrameWindow(recordStart, recordEnd - recordStart);
        }
        const cie = yield* decodeCie({
          recordStart,
          recordEnd,
          body: body + idWidth,
          findNul: winAccess.findNul,
          subarray: winAccess.subarray,
          *readU8(offset, end) {
            if (offset >= end) return null;
            yield* ensureFrameWindow(offset, 1);
            return winAccess.readU8(offset, end);
          },
          *readLeb(offset, end, signed) {
            if (offset >= end) return null;
            yield* ensureFrameWindow(
              offset,
              Math.min(Math.ceil(ULEB64.bits / 7), end - offset),
            );
            return winAccess.readLeb(offset, end, signed);
          },
          *readEncoded(offset, end, encoding, bases) {
            if (offset < end)
              yield* ensureFrameWindow(
                offset,
                Math.min(MAX_ENCODED_POINTER_BYTES, end - offset),
              );
            return winAccess.readEncoded(offset, end, encoding, bases);
          },
          safeInt,
          encodingOf,
          datarel: gotBase?.address ?? null,
          textrel: textBaseAddress,
          fail,
        });
        // A rejected CIE also ends an unbounded scan: libgcc rejects the
        // whole table at an unrecognized augmentation.
        if (cie === "unknown-augmentation") {
          rejectedCies.add(recordStart);
          undecoded = true;
        } else if (cie === null) undecoded = true;
        else {
          const stored = { ...cie, index: cies.length };
          cies.push(stored);
          cieAt.set(recordStart, stored);
        }
      } else {
        // The CIE pointer is a byte distance from this field back to the CIE
        // length, the same subtraction GCC performs on void pointers.
        const field = body;
        if (id > field) {
          fail("An FDE referenced a CIE that was not decoded.");
          undecoded = true;
        } else {
          const cie = cieAt.get(field - id);
          const rejected = rejectedCies.has(field - id);
          const decoded =
            cie === undefined
              ? null
              : decodeFde({
                  recordStart,
                  recordEnd,
                  body: body + idWidth,
                  cie,
                  readLeb: winAccess.readLeb,
                  readEncoded: winAccess.readEncoded,
                  safeInt,
                  bases: fdeBases,
                  lengthBases: fdeLengthBases,
                  datarel: gotBase?.address ?? null,
                  textrel: textBaseAddress,
                  fail,
                });
          if (rejected) {
            rejectedFdes += 1;
            undecoded = true;
          } else if (cie === undefined) {
            fail("An FDE referenced a CIE that was not decoded.");
            undecoded = true;
          } else if (decoded === "discarded") discarded += 1;
          else if (decoded === "indirect") indirectFdes += 1;
          else if (decoded === null) undecoded = true;
          else ranges.push({ ...decoded, index: ranges.length });
        }
      }
      cursor = recordEnd;
      if (undecoded && stopAtBadRecord) {
        fail(UNBOUNDED_STOPPED);
        terminated = true;
        break;
      }
    }
    if (stopAtBadRecord && !terminated && frameStatus === "present")
      fail(UNBOUNDED_UNTERMINATED);
    if (frameClamped) frameStatus = "incomplete";
    if (discarded > 0) note(discardedLimitation(discarded));
    if (indirectFdes > 0) fail(indirectFdeLimitation(indirectFdes));
    if (rejectedFdes > 0) fail(unknownAugmentationLimitation(rejectedFdes));
    if (datarelMissing) fail(DATAREL_UNRESOLVED);
    else if (datarelUsed && gotBase !== null)
      note(
        `DW_EH_PE_datarel .eh_frame values were resolved against the GOT base from ${gotBase.source}.`,
      );
    if (frameSource === "program" && frameLocation !== null) {
      frameLocation = {
        offset: frameLocation.offset,
        bytes: Math.max(0, Math.min(cursor, extent) - frameLocation.offset),
      };
    }
  }

  const wantedStarts = new Set<bigint>();
  for (const range of ranges) wantedStarts.add(range.startValue);
  const symbols = yield* scanSymbols(directory, wantedStarts, signal, {
    fail,
    note,
  });
  const relocatable = directory.elf_type === 1;
  if (relocatable)
    fail(
      "Relocations are not applied. Relocatable symbol values use the section address plus the symbol value.",
    );
  const zeroAddresses =
    relocatable &&
    directory.sections.every((section) => section.address === 0n);
  if (zeroAddresses && ranges.length > 0)
    fail(
      "Function ranges could not be placed in a section because every section address is zero.",
    );
  const containingSection = zeroAddresses
    ? null
    : containingSectionIndex(directory.sections);
  let withSymbols = 0;
  for (const range of ranges)
    if (symbols.has(range.startValue)) withSymbols += 1;
  const decodeName = symbolNameDecoder();
  // Names and address strings are formatted only for the returned page.
  const pageRows: ElfUnwindRanges["ranges"] = [];
  for (const range of ranges.slice(input.offset, input.offset + input.limit)) {
    const symbol = symbols.get(range.startValue)?.name;
    const section = containingSection?.(range.startValue) ?? null;
    const endValue = BigInt.asUintN(bits, range.startValue + range.sizeValue);
    pageRows.push({
      index: range.index,
      start: hex(range.startValue),
      end: hex(endValue),
      size: range.sizeValue.toString(),
      section:
        section?.name === null ||
        section?.name === undefined ||
        section.name.length === 0
          ? null
          : { text: section.name, trust: "untrusted" as const },
      symbol:
        symbol === undefined
          ? null
          : { text: yield* decodeName(symbol), trust: "untrusted" as const },
      cie_index: range.cie_index,
      lsda:
        range.lsda === null
          ? null
          : {
              address: hex(range.lsda.addressValue),
              indirect: range.lsda.indirect,
            },
      personality: range.personality,
      location: range.location,
    });
  }
  const pageCieIndexes = new Set(pageRows.map((range) => range.cie_index));
  const pageCies = cies.filter((cie) => pageCieIndexes.has(cie.index));
  const agreement = headerAgreement(
    header,
    ranges,
    ehSection === undefined
      ? undefined
      : (vaForFileOffset(Number(ehSection.offset)) ?? undefined),
    note,
  );

  if (header.status === "absent" && frameStatus !== "unknown")
    note(HEADER_ABSENT, "eh_frame_hdr_absent");
  note(CFA_LIMITATION, "cfa_not_evaluated");
  if (debugFrame.status === "present")
    note(DEBUG_PRESENT, "debug_frame_present_undecoded");
  else if (debugFrame.status === "absent")
    note(DEBUG_ABSENT, "debug_frame_absent");
  else if (debugFrame.status === "unknown")
    note(DEBUG_UNKNOWN, "debug_frame_unknown");
  note(UNTRUSTED_LIMITATION, "untrusted_names");
  if (sawIndirect)
    note(INDIRECT_LIMITATION, "indirect_pointers_not_dereferenced");

  const returned: ElfUnwindRanges = {
    artifact,
    format: bits === 64 ? "elf64" : "elf32",
    byte_order: little ? "little" : "big",
    machine: directory.machine,
    type: directory.elf_type,
    type_name: elfObjectTypeName(directory.elf_type),
    eh_frame: {
      status: frameStatus,
      source: frameSource,
      location: frameLocation,
    },
    eh_frame_hdr: {
      status: header.status,
      location: header.location,
      version: header.version,
      eh_frame_pointer_encoding: header.eh_frame_pointer_encoding,
      fde_count_encoding: header.fde_count_encoding,
      table_encoding: header.table_encoding,
      eh_frame_pointer: header.eh_frame_pointer,
      fde_count: header.fde_count,
      table_entries: header.table_entries,
    },
    debug_frame: debugFrame,
    // Only CIEs that this page's ranges name, so the page size bounds output.
    cies: pageCies.map((cie) => ({
      index: cie.index,
      version: cie.version,
      augmentation: {
        text: cie.augmentation.toString("latin1"),
        trust: "untrusted" as const,
      },
      code_alignment: cie.code_alignment,
      data_alignment: cie.data_alignment,
      return_address_register: cie.return_address_register,
      pointer_encoding: cie.pointer_encoding,
      lsda_encoding: cie.lsda_encoding,
      personality: cie.personality,
      signal_frame: cie.signal_frame,
      b_key: cie.b_key,
      instruction_bytes: cie.instruction_bytes,
      location: cie.location,
    })),
    ranges: pageRows,
    page: {
      offset: input.offset,
      limit: input.limit,
      returned: pageRows.length,
      total: ranges.length,
      next_offset:
        input.offset + pageRows.length >= ranges.length
          ? null
          : input.offset + pageRows.length,
    },
    coverage: {
      status: incomplete ? "partial" : "complete",
      total_ranges: ranges.length,
      total_cies: cies.length,
      ranges_with_symbols: withSymbols,
      ranges_without_symbols: ranges.length - withSymbols,
      eh_frame_hdr_agreement: agreement,
      examined_records: examined,
    },
    limitation_codes: limitationCodes,
    limitations,
  };
  return returned;
}

const fileRange = (section: NativeSection): FileRange | null => {
  if (
    section.offset < 0n ||
    section.size < 0n ||
    section.offset > 0xffffffffn ||
    section.size > 0xffffffffn
  )
    return null;
  return { offset: Number(section.offset), bytes: Number(section.size) };
};

/**
 * GOT base for `.eh_frame` DW_EH_PE_datarel values: DT_PLTGOT, then the
 * `.got.plt` address, then the `.got` address. Null when none is declared,
 * when a repeated PT_DYNAMIC header, SHT_DYNAMIC section or allocated GOT
 * section leaves the source ambiguous, or when the dynamic table is not read
 * through DT_NULL or declares different DT_PLTGOT values.
 */
function* resolveGotBase(
  fileBytes: number,
  directory: ElfSectionDirectory,
): Generator<
  ReadStep,
  { readonly address: bigint; readonly source: string } | null,
  Buffer
> {
  // The ELF gABI allows one PT_DYNAMIC and one SHT_DYNAMIC section; with
  // repeats, read neither rather than choosing one by position or falling
  // back to another source.
  const dynamicProgram = uniqueKeyed(
    keyedBy(directory.programs, ({ type }) => type),
    2,
  );
  if (!dynamicProgram.ok) return null;
  let dynamic: { readonly offset: bigint; readonly fileSize: bigint } | null =
    null;
  if (dynamicProgram.value?.type === 2)
    dynamic = {
      offset: dynamicProgram.value.offset,
      fileSize: dynamicProgram.value.size,
    };
  else {
    const dynamicSection = uniqueKeyed(
      keyedBy(directory.sections, ({ type }) => type),
      SHT_DYNAMIC,
    );
    if (!dynamicSection.ok) return null;
    const section = dynamicSection.value;
    if (section?.file_backed === true && !section.compressed)
      dynamic = { offset: section.offset, fileSize: section.size };
  }
  if (dynamic !== null) {
    const start = dynamic.offset;
    const end = dynamic.offset + dynamic.fileSize;
    // An unread declared table may name a base the sections do not.
    if (start < 0n || end > BigInt(fileBytes)) return null;
    const width = directory.bits === 64 ? 16 : 8;
    const maxRead = Math.min(
      Number(dynamic.fileSize),
      MAX_DYNAMIC_ENTRIES * width,
    );
    const dynBytes = yield* readSlice(Number(start), maxRead);
    const bases = new Set<bigint>();
    const walked = walkElfDynamicTable<never>(
      dynBytes,
      { bits: directory.bits, littleEndian: directory.little },
      new Set(),
      ({ tag, value }) => {
        if (tag === DT_PLTGOT && value !== 0n) bases.add(value);
      },
    );
    // A row past the examined bytes, before DT_NULL, could name another base.
    if (!walked.ok || walked.value.terminatorOffset === null || bases.size > 1)
      return null;
    const [base] = bases;
    if (base !== undefined) return { address: base, source: "DT_PLTGOT" };
  }
  // Only an allocated section has a load address; a repeated allocated GOT
  // section has no single base.
  const allocated = keyedBy(
    directory.sections.filter(({ flags }) => (flags & SHF_ALLOC) !== 0n),
    ({ name }) => name,
  );
  for (const name of [".got.plt", ".got"]) {
    const section = uniqueKeyed(allocated, name);
    if (!section.ok) return null;
    if (section.value !== undefined && section.value.address !== 0n)
      return { address: section.value.address, source: `the ${name} section` };
  }
  return null;
}

interface ProgramSpan {
  readonly flags: number;
  readonly offset: bigint;
  readonly virtualAddress: bigint;
  readonly fileSize: bigint;
}

const programSpan = (
  program: Exclude<ElfProgramDeclaration, { type: 2 }>,
): ProgramSpan => ({
  flags: program.flags,
  offset: program.file_offset,
  virtualAddress: program.virtual_address,
  fileSize: program.file_size,
});

const emptyHeader = (
  status: HeaderDecode["status"],
  location: FileRange | null,
): HeaderDecode => ({
  status,
  location,
  version: null,
  eh_frame_pointer_encoding: null,
  fde_count_encoding: null,
  table_encoding: null,
  eh_frame_pointer: null,
  ehFramePointer: null,
  fde_count: null,
  table_entries: 0,
  rows: [],
  decoded: false,
});

const decodeHeader = (
  location: FileRange,
  datarel: bigint | null,
  textrel: bigint | null,
  readEncoded: ReadEncoded,
  readU8: (offset: number, end: number) => number | null,
  safeInt: (value: bigint) => number | null,
  hex: (value: bigint) => string,
  fileOffsetForVa: (address: bigint) => number | null,
  fail: (text: string) => void,
  signal: AbortSignal | undefined,
  limits: { readonly maxRows: number; readonly addressSize: 4 | 8 },
): HeaderDecode => {
  const end = location.offset + location.bytes;
  const version = readU8(location.offset, end);
  const ptrEnc = readU8(location.offset + 1, end);
  const countEnc = readU8(location.offset + 2, end);
  const tableEnc = readU8(location.offset + 3, end);
  const base = {
    status: "incomplete" as const,
    location,
    version,
    eh_frame_pointer_encoding:
      ptrEnc === null
        ? null
        : { raw: ptrEnc, name: elfEhPointerEncodingName(ptrEnc) },
    fde_count_encoding:
      countEnc === null
        ? null
        : { raw: countEnc, name: elfEhPointerEncodingName(countEnc) },
    table_encoding:
      tableEnc === null
        ? null
        : { raw: tableEnc, name: elfEhPointerEncodingName(tableEnc) },
    eh_frame_pointer: null,
    ehFramePointer: null,
    fde_count: null,
    table_entries: 0,
    rows: [],
    decoded: false,
  };
  if (
    version === null ||
    ptrEnc === null ||
    countEnc === null ||
    tableEnc === null
  ) {
    fail(".eh_frame_hdr is truncated.");
    return base;
  }
  if (version !== 1) {
    fail(`.eh_frame_hdr version ${String(version)} is not decoded.`);
    return { ...base, version };
  }
  const pointer = readEncoded(location.offset + 4, end, ptrEnc, {
    datarel,
    textrel,
    funcrel: null,
    lengthOnly: false,
  });
  if (pointer === null || pointer === "omit") {
    fail(".eh_frame_hdr eh_frame_ptr could not be decoded.");
    return { ...base, version };
  }
  // An indirect eh_frame_ptr names a pointer slot, not .eh_frame, and is not
  // followed, so it locates nothing.
  if (pointer.indirect) {
    fail(INDIRECT_FRAME_POINTER);
    return { ...base, version };
  }
  // GNU ld writes omitted count and table encodings when it cannot build the
  // binary-search table. That is a valid header with no table, not a failure.
  if (countEnc === DW_EH_PE_OMIT)
    return {
      ...base,
      status: "present",
      version,
      eh_frame_pointer: hex(pointer.address),
      ehFramePointer: pointer.address,
    };
  const countValue = readEncoded(pointer.next, end, countEnc, {
    datarel,
    textrel,
    funcrel: null,
    lengthOnly: (countEnc & 0x70) === 0,
  });
  if (countValue === null || countValue === "omit" || countValue.address < 0n) {
    fail(".eh_frame_hdr FDE count could not be decoded.");
    return {
      ...base,
      version,
      eh_frame_pointer: hex(pointer.address),
      ehFramePointer: pointer.address,
    };
  }
  // A non-zero indirect count is the address of a slot holding the count. The
  // slot is not followed, so the count, and with it the table, is unknown.
  if ((countEnc & 0x80) !== 0 && countValue.address !== 0n) {
    fail(INDIRECT_COUNT);
    return {
      ...base,
      version,
      eh_frame_pointer: hex(pointer.address),
      ehFramePointer: pointer.address,
    };
  }
  if (countValue.address > 0xffffffffn) {
    fail(".eh_frame_hdr FDE count does not fit in 32 bits.");
    return {
      ...base,
      version,
      eh_frame_pointer: hex(pointer.address),
      ehFramePointer: pointer.address,
    };
  }
  const count = safeInt(countValue.address);
  if (count === null || count < 0) {
    fail(".eh_frame_hdr FDE count could not be decoded.");
    return {
      ...base,
      version,
      eh_frame_pointer: hex(pointer.address),
      ehFramePointer: pointer.address,
    };
  }
  // An omitted table is a valid header without a binary-search table; libgcc
  // then searches linearly. Test the sentinel before the indirect bit it sets.
  if (tableEnc === DW_EH_PE_OMIT)
    return {
      ...base,
      status: "present",
      version,
      eh_frame_pointer: hex(pointer.address),
      ehFramePointer: pointer.address,
      fde_count: count,
    };
  // Indirect table entries name pointer slots, not starts or FDEs. They are
  // not followed, so the table is neither compared nor used as a scan bound.
  if ((tableEnc & 0x80) !== 0) {
    fail(INDIRECT_TABLE);
    return {
      ...base,
      version,
      eh_frame_pointer: hex(pointer.address),
      ehFramePointer: pointer.address,
      fde_count: count,
    };
  }
  // The declared count is target-controlled: bound rows by the caller's
  // max_ranges budget and by how many rows the section bytes can hold before
  // allocating any, and report a capped table as incomplete.
  const rowBytes = 2 * minimumEncodedBytes(tableEnc, limits.addressSize);
  const fitting = Math.floor(Math.max(0, end - countValue.next) / rowBytes);
  const readable = Math.min(count, limits.maxRows, fitting);
  if (count > limits.maxRows)
    fail(
      `.eh_frame_hdr declares ${String(count)} FDEs, more than the max_ranges budget of ${String(limits.maxRows)}; only ${String(readable)} search-table rows were read and the table was not compared with the decoded FDEs.`,
    );
  if (count > fitting)
    fail(
      `.eh_frame_hdr declares ${String(count)} FDEs but its bytes hold at most ${String(fitting)} search-table rows; the table is truncated.`,
    );
  const rows: HeaderRow[] = [];
  let cursor = countValue.next;
  for (let index = 0; index < readable; index += 1) {
    assertArtifactReadActive(signal);
    const start = readEncoded(cursor, end, tableEnc, {
      datarel,
      textrel,
      funcrel: null,
      lengthOnly: false,
    });
    if (start === null || start === "omit") {
      fail(".eh_frame_hdr table is truncated.");
      return {
        ...base,
        version,
        eh_frame_pointer: hex(pointer.address),
        ehFramePointer: pointer.address,
        fde_count: count,
        table_entries: rows.length,
        rows,
      };
    }
    const fde = readEncoded(start.next, end, tableEnc, {
      datarel,
      textrel,
      funcrel: null,
      lengthOnly: false,
    });
    if (fde === null || fde === "omit") {
      fail(".eh_frame_hdr table is truncated.");
      return {
        ...base,
        version,
        eh_frame_pointer: hex(pointer.address),
        ehFramePointer: pointer.address,
        fde_count: count,
        table_entries: rows.length,
        rows,
      };
    }
    rows.push({
      startValue: start.address,
      fdeFileOffset: fileOffsetForVa(fde.address),
    });
    cursor = fde.next;
  }
  if (readable < count)
    return {
      ...base,
      version,
      eh_frame_pointer: hex(pointer.address),
      ehFramePointer: pointer.address,
      fde_count: count,
      table_entries: rows.length,
      rows,
    };
  return {
    status: "present",
    location,
    version,
    eh_frame_pointer_encoding: base.eh_frame_pointer_encoding,
    fde_count_encoding: base.fde_count_encoding,
    table_encoding: base.table_encoding,
    eh_frame_pointer: hex(pointer.address),
    ehFramePointer: pointer.address,
    fde_count: count,
    table_entries: rows.length,
    rows,
    decoded: true,
  };
};

/** Fewest bytes one DW_EH_PE value of this encoding can occupy. */
const minimumEncodedBytes = (encoding: number, addressSize: 4 | 8): number => {
  if (encoding === 0x50) return addressSize;
  switch (encoding & 0x0f) {
    case 0x00:
      return addressSize;
    case 0x02:
    case 0x0a:
      return 2;
    case 0x03:
    case 0x0b:
      return 4;
    case 0x04:
    case 0x0c:
      return 8;
    default:
      return 1;
  }
};

const decodeCie = function* (args: {
  readonly recordStart: number;
  readonly recordEnd: number;
  readonly body: number;
  readonly findNul: (start: number, end: number) => number;
  readonly subarray: (start: number, end: number) => Buffer;
  readonly readU8: (
    offset: number,
    end: number,
  ) => Generator<ReadStep, number | null, Buffer>;
  readonly readLeb: (
    offset: number,
    end: number,
    signed: boolean,
  ) => Generator<ReadStep, ReturnType<SliceAccessors["readLeb"]>, Buffer>;
  readonly readEncoded: (
    ...args: Parameters<ReadEncoded>
  ) => Generator<ReadStep, ReturnType<ReadEncoded>, Buffer>;
  readonly safeInt: (value: bigint) => number | null;
  readonly encodingOf: (raw: number) => Encoding;
  readonly datarel: bigint | null;
  readonly textrel: bigint | null;
  readonly fail: (text: string) => void;
}): Generator<
  ReadStep,
  Omit<CieRecord, "index"> | "unknown-augmentation" | null,
  Buffer
> {
  const {
    recordStart,
    recordEnd,
    body,
    findNul,
    subarray,
    readU8,
    readLeb,
    readEncoded,
    safeInt,
    encodingOf,
    datarel,
    textrel,
    fail,
  } = args;
  const version = yield* readU8(body, recordEnd);
  if (version === null) {
    fail("A CIE record is truncated.");
    return null;
  }
  let cursor = body + 1;
  // One bounded NUL search inside the record. Copy only the short augmentation
  // bytes so the streaming window buffer is never retained by the CIE record.
  const terminator = findNul(cursor, recordEnd);
  const augmentation = Buffer.from(
    subarray(cursor, terminator < 0 ? recordEnd : cursor + terminator),
  );
  cursor = terminator < 0 ? recordEnd : cursor + terminator + 1;
  if (version !== 1 && version !== 3) {
    fail(`CIE version ${String(version)} is not decoded.`);
    return null;
  }
  const code = yield* readLeb(cursor, recordEnd, false);
  if (code === null) {
    fail("A CIE record is truncated.");
    return null;
  }
  const data = yield* readLeb(code.next, recordEnd, true);
  if (data === null) {
    fail("A CIE record is truncated.");
    return null;
  }
  const codeAlignment = safeInt(code.value);
  const dataAlignment = safeInt(data.value);
  if (codeAlignment === null || codeAlignment < 0 || dataAlignment === null) {
    fail("A CIE alignment does not fit an integer.");
    return null;
  }
  cursor = data.next;
  let returnAddress: number | null;
  if (version === 1) {
    returnAddress = yield* readU8(cursor, recordEnd);
    cursor += 1;
  } else {
    const register = yield* readLeb(cursor, recordEnd, false);
    if (register === null) {
      fail("A CIE record is truncated.");
      return null;
    }
    returnAddress = safeInt(register.value);
    cursor = register.next;
  }
  if (returnAddress === null || returnAddress < 0) {
    fail("A CIE return-address register does not fit an integer.");
    return null;
  }
  const hasZ = augmentation[0] === AUG_Z;
  let augEnd = cursor;
  if (hasZ) {
    const length = yield* readLeb(cursor, recordEnd, false);
    if (length === null) {
      fail("A CIE augmentation length is truncated.");
      return null;
    }
    const augLength = safeInt(length.value);
    if (
      augLength === null ||
      augLength < 0 ||
      length.next + augLength > recordEnd
    ) {
      fail("A CIE augmentation length is truncated.");
      return null;
    }
    cursor = length.next;
    augEnd = cursor + augLength;
  }
  let lsda: Encoding | null = null;
  let personality: Personality | null = null;
  let pointer = encodingOf(0);
  let signal = false;
  let bKey = false;
  const letters = hasZ ? augmentation.subarray(1) : augmentation;
  for (const letter of letters) {
    if (letter === AUG_L) {
      const raw = yield* readU8(cursor, hasZ ? augEnd : recordEnd);
      if (raw === null) {
        fail("A CIE augmentation is truncated.");
        return null;
      }
      lsda = encodingOf(raw);
      cursor += 1;
    } else if (letter === AUG_P) {
      const raw = yield* readU8(cursor, hasZ ? augEnd : recordEnd);
      if (raw === null) {
        fail("A CIE augmentation is truncated.");
        return null;
      }
      const encoded = yield* readEncoded(
        cursor + 1,
        hasZ ? augEnd : recordEnd,
        raw,
        {
          datarel,
          textrel,
          funcrel: null,
          lengthOnly: false,
        },
      );
      if (encoded === null || encoded === "omit") {
        fail("A CIE personality pointer could not be decoded.");
        return null;
      }
      personality = {
        address: `0x${encoded.address.toString(16)}`,
        encoding: encodingOf(raw),
        indirect: encoded.indirect,
      };
      cursor = encoded.next;
    } else if (letter === AUG_R) {
      const raw = yield* readU8(cursor, hasZ ? augEnd : recordEnd);
      if (raw === null) {
        fail("A CIE augmentation is truncated.");
        return null;
      }
      pointer = encodingOf(raw);
      cursor += 1;
    } else if (letter === AUG_S) signal = true;
    else if (letter === AUG_B) bKey = true;
    else {
      // The augmentation data length would let a z CIE skip unknown data, but
      // the encodings of letters after an unknown one cannot be located, so
      // FDEs are never decoded against this CIE (libgcc rejects it too).
      fail(UNKNOWN_AUGMENTATION);
      return "unknown-augmentation";
    }
  }
  const instructionStart = hasZ ? augEnd : cursor;
  if (instructionStart > recordEnd) {
    fail("A CIE augmentation is truncated.");
    return null;
  }
  const instructionBytes = recordEnd - instructionStart;
  if (instructionBytes > 0xffffffff) {
    fail("A CIE instruction block does not fit a file range.");
    return null;
  }
  return {
    version,
    augmentation,
    code_alignment: codeAlignment,
    data_alignment: dataAlignment,
    return_address_register: returnAddress,
    pointer_encoding: pointer,
    lsda_encoding: lsda,
    personality,
    signal_frame: signal,
    b_key: bKey,
    instruction_bytes: instructionBytes,
    location: { offset: recordStart, bytes: recordEnd - recordStart },
    hasZ,
  };
};

const decodeFde = (args: {
  readonly recordStart: number;
  readonly recordEnd: number;
  readonly body: number;
  readonly cie: CieRecord;
  readonly readLeb: (
    offset: number,
    end: number,
    signed: boolean,
  ) => { readonly value: bigint; readonly next: number } | null;
  readonly readEncoded: ReadEncoded;
  readonly safeInt: (value: bigint) => number | null;
  readonly bases: PointerBases;
  readonly lengthBases: PointerBases;
  readonly datarel: bigint | null;
  readonly textrel: bigint | null;
  readonly fail: (text: string) => void;
}): Omit<DecodedRange, "index"> | "discarded" | "indirect" | null => {
  const {
    recordStart,
    recordEnd,
    body,
    cie,
    readLeb,
    readEncoded,
    safeInt,
    bases,
    lengthBases,
    datarel,
    textrel,
    fail,
  } = args;
  const start = readEncoded(body, recordEnd, cie.pointer_encoding.raw, bases);
  if (start === null || start === "omit") {
    fail("An FDE initial location could not be decoded.");
    return null;
  }
  // A zero initial location marks an FDE whose function the linker discarded
  // (libgcc skips these); it does not name a function.
  if (start.address === 0n) return "discarded";
  // An indirect initial location is the address of a pointer slot. The slot
  // is not followed, so the function start is unknown.
  if (start.indirect) return "indirect";
  // address_range uses only the value format. It is not PC-relative.
  const length = readEncoded(
    start.next,
    recordEnd,
    cie.pointer_encoding.raw & 0x0f,
    lengthBases,
  );
  if (length === null || length === "omit") {
    fail("An FDE address range could not be decoded.");
    return null;
  }
  if (length.address < 0n) {
    fail("An FDE address range is negative.");
    return null;
  }
  let cursor = length.next;
  let lsda: DecodedRange["lsda"] = null;
  if (cie.hasZ) {
    const aug = readLeb(cursor, recordEnd, false);
    if (aug === null) {
      fail("An FDE augmentation length is truncated.");
      return null;
    }
    const augLength = safeInt(aug.value);
    if (
      augLength === null ||
      augLength < 0 ||
      aug.next + augLength > recordEnd
    ) {
      fail("An FDE augmentation length is truncated.");
      return null;
    }
    const augEnd = aug.next + augLength;
    if (cie.lsda_encoding !== null && cie.lsda_encoding.raw !== 0xff) {
      const encoded = readEncoded(aug.next, augEnd, cie.lsda_encoding.raw, {
        datarel,
        textrel,
        funcrel: start.address,
        lengthOnly: false,
      });
      if (encoded === null || encoded === "omit") {
        fail("An FDE LSDA pointer could not be decoded.");
        return null;
      }
      // A zero LSDA pointer means the FDE has no LSDA.
      if (encoded.address !== 0n)
        lsda = {
          addressValue: encoded.address,
          indirect: encoded.indirect,
        };
    }
    cursor = augEnd;
  }
  if (cursor > recordEnd) {
    fail("An FDE record is truncated.");
    return null;
  }
  return {
    cie_index: cie.index,
    lsda,
    personality:
      cie.personality === null
        ? null
        : {
            address: cie.personality.address,
            indirect: cie.personality.indirect,
          },
    location: { offset: recordStart, bytes: recordEnd - recordStart },
    startValue: start.address,
    sizeValue: length.address,
  };
};

/** The source range of a validated NUL-terminated symbol name. */
interface SymbolName {
  readonly offset: number;
  readonly contentBytes: number;
}

interface MatchedSymbol {
  readonly name: SymbolName;
  readonly score: number;
  readonly ifunc: boolean;
}

/**
 * Exact-start symbol names for the FDE starts in `wanted`. Candidate records
 * are filtered on decoded symbol facts before reading names,
 * and each name retains only its location and length until page selection.
 */
function* scanSymbols(
  directory: ElfSectionDirectory,
  wanted: ReadonlySet<bigint>,
  signal: AbortSignal | undefined,
  report: {
    readonly fail: (text: string) => void;
    readonly note: (text: string) => void;
  },
): Generator<ReadStep, Map<bigint, MatchedSymbol>, Buffer> {
  const { fail, note } = report;
  const found = new Map<bigint, MatchedSymbol>();
  const tables = directory.sections.filter(
    (section) => section.type === SHT_SYMTAB || section.type === SHT_DYNSYM,
  );
  const standard = elfSymbolSize(directory.bits);
  const relocatable = directory.elf_type === 1;
  const isArm = directory.machine === EM_ARM;
  // First section per index, matching a directory-order find.
  const byIndex = new Map<number, NativeSection>();
  for (const section of directory.sections)
    if (!byIndex.has(section.index)) byIndex.set(section.index, section);
  // One budget across .symtab and .dynsym together.
  let remaining = MAX_ELF_UNWIND_SYMBOLS;
  for (const table of tables) {
    assertArtifactReadActive(signal);
    if (table.compressed) {
      fail("A symbol table is SHF_COMPRESSED and was not decompressed.");
      continue;
    }
    const width = table.entry_size === 0n ? standard : Number(table.entry_size);
    if (width !== standard) {
      fail(
        "Symbol table entry width is not the ELF32/ELF64 symbol size; that table was skipped.",
      );
      continue;
    }
    if (!table.file_backed || table.size <= 0n) {
      fail("A symbol table is declared but not file-backed.");
      continue;
    }
    const start = Number(table.offset);
    const size = Number(table.size);
    if (size % width !== 0)
      fail("A symbol table size is not a multiple of its entry width.");
    const strings = byIndex.get(table.link);
    if (strings?.type !== SHT_STRTAB || !strings.file_backed) {
      fail("A symbol table does not link to a file-backed SHT_STRTAB section.");
      continue;
    }
    if (strings.compressed) {
      fail("A symbol string table is SHF_COMPRESSED and was not decompressed.");
      continue;
    }
    let count = Math.floor(size / width);
    if (count > remaining) {
      fail(
        `Symbol tables were capped at ${String(MAX_ELF_UNWIND_SYMBOLS)} combined entries.`,
      );
      count = remaining;
    }
    remaining -= count;
    const strStart = Number(strings.offset);
    const strSize = Number(strings.size);
    const strEnd = strStart + strSize;
    let strWinBuf: Buffer = Buffer.alloc(0);
    let strWinStart = 0;
    const symtabBonus = table.type === SHT_SYMTAB ? 1 : 0;
    // Observation per string-table offset; null when the name is unreadable.
    const names = new Map<number, SymbolName | null>();
    let recentName: SymbolName | undefined;
    const entriesPerChunk = Math.max(
      1,
      Math.floor(STREAM_WINDOW_BYTES / width),
    );
    let symChunk: Buffer = Buffer.alloc(0);
    let symChunkFirst = 0;
    let symChunkCount = 0;
    for (let index = 0; index < count; index += 1) {
      assertArtifactReadActive(signal);
      if (index < symChunkFirst || index >= symChunkFirst + symChunkCount) {
        const batch = Math.min(entriesPerChunk, count - index);
        symChunk = yield* readSlice(start + index * width, batch * width);
        symChunkFirst = index;
        symChunkCount = batch;
      }
      const at = (index - symChunkFirst) * width;
      const symbol = readElfSymbolFieldsAt(
        symChunk,
        at,
        directory.bits,
        directory.little,
      );
      if (symbol === null) {
        fail("A symbol record is truncated.");
        break;
      }
      const {
        type: symbolType,
        section_index: sectionIndex,
        name_offset: nameOffset,
      } = symbol;
      if (
        symbolType !== STT_FUNC &&
        symbolType !== STT_GNU_IFUNC &&
        symbolType !== STT_NOTYPE
      )
        continue;
      if (sectionIndex === SHN_UNDEF) continue;
      if (sectionIndex >= SHN_LORESERVE && sectionIndex !== SHN_ABS) continue;
      let address = readElfSymbolValueAt(
        symChunk,
        at,
        directory.bits,
        directory.little,
      );
      if (relocatable && sectionIndex !== SHN_ABS) {
        const owner = byIndex.get(sectionIndex);
        if (owner !== undefined) address += owner.address;
      }
      // An ARM function symbol sets bit 0 for Thumb code; the code, and so its
      // FDE initial location, starts at the even address.
      if (isArm && symbolType !== STT_NOTYPE) address &= ~1n;
      // Only a symbol at a decoded FDE start can name a range.
      if (!wanted.has(address)) continue;
      let name = names.get(nameOffset);
      if (name === undefined) {
        name = null;
        if (nameOffset >= 0 && nameOffset < strSize) {
          const offset = strStart + nameOffset;
          if (
            recentName !== undefined &&
            offset >= recentName.offset &&
            offset <= recentName.offset + recentName.contentBytes
          ) {
            // A suffix through the admitted terminator has no earlier NUL.
            const contentBytes =
              recentName.offset + recentName.contentBytes - offset;
            name = { contentBytes, offset };
          } else {
            const relative = offset - strWinStart;
            let observed: ElfStringTableObservation | undefined;
            if (relative >= 0 && relative < strWinBuf.length)
              observed = observeElfStringTableEntry(
                strWinBuf,
                relative,
                STREAM_WINDOW_BYTES,
              );
            if (
              observed === undefined ||
              (observed.state === "truncated" &&
                strWinStart + strWinBuf.length < strEnd)
            ) {
              strWinBuf = yield* readSlice(
                offset,
                Math.min(STREAM_WINDOW_BYTES, strEnd - offset),
              );
              strWinStart = offset;
              observed = observeElfStringTableEntry(
                strWinBuf,
                0,
                STREAM_WINDOW_BYTES,
              );
            }
            if (observed.state === "terminated") {
              name = { contentBytes: observed.contentBytes, offset };
              recentName = name;
            }
          }
        }
        names.set(nameOffset, name);
      }
      if (name === null) {
        fail("A symbol name could not be read.");
        continue;
      }
      if (name.contentBytes === 0) continue;
      // A function symbol is preferred, then an IFUNC resolver, then an
      // untyped label; .symtab breaks ties.
      const score =
        (symbolType === STT_FUNC ? 4 : symbolType === STT_GNU_IFUNC ? 2 : 0) +
        symtabBonus;
      const previous = found.get(address);
      if (previous === undefined || score > previous.score)
        found.set(address, {
          name,
          score,
          ifunc: symbolType === STT_GNU_IFUNC,
        });
    }
  }
  for (const item of found.values()) {
    if (item.ifunc) {
      note(IFUNC_NAMES);
      break;
    }
  }
  return found;
}

/**
 * Decode returned symbol names once each, charging their text against a fixed
 * allowance before converting it.
 */
const symbolNameDecoder = (): ((
  name: SymbolName,
) => Generator<ReadStep, string, Buffer>) => {
  const decoded = new Map<SymbolName, string>();
  let charged = 0;
  return function* (name) {
    const cached = decoded.get(name);
    if (cached !== undefined) return cached;
    charged += name.contentBytes;
    if (charged > MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES)
      throw decodeLimit(
        ELF_UNWIND_FORMAT,
        `ELF unwind symbol names on this page exceed the ${String(MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES)}-byte symbol-name text allowance.`,
        {
          name: "symbol_name_text_bytes",
          maximum: MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES,
        },
      );
    const bytes = yield* readSlice(name.offset, name.contentBytes);
    const text = elfStringTableText({
      state: "terminated",
      contentBytes: name.contentBytes,
      examinedBytes: name.contentBytes + 1,
      bytes,
    });
    decoded.set(name, text);
    return text;
  };
};

/**
 * Index of the SHF_ALLOC section that owns each address: SHF_EXECINSTR first,
 * then the smallest section, then the lowest index. Non-ALLOC sections such as
 * .comment or .debug_* are not loaded, so they never contain a function.
 * Built once per image.
 */
const containingSectionIndex = (
  sections: readonly NativeSection[],
): ((address: bigint) => NativeSection | undefined) =>
  buildIntervalIndex(
    sections
      .filter(
        (section) => section.size > 0n && (section.flags & SHF_ALLOC) !== 0n,
      )
      .map((section) => ({
        low: section.address,
        high: section.address + section.size,
        value: section,
      })),
    (left, right) => {
      const leftExec = (left.flags & SHF_EXECINSTR) !== 0n;
      const rightExec = (right.flags & SHF_EXECINSTR) !== 0n;
      if (leftExec !== rightExec) return leftExec ? -1 : 1;
      if (left.size !== right.size) return left.size < right.size ? -1 : 1;
      return left.index - right.index;
    },
  );

const headerAgreement = (
  header: HeaderDecode,
  ranges: readonly {
    readonly startValue: bigint;
    readonly location: FileRange;
  }[],
  sectionAddress: bigint | undefined,
  note: (text: string, code?: ElfUnwindLimitationCode) => void,
): "agree" | "disagree" | "unavailable" => {
  // The only owner of the eh_frame_ptr check; it also runs for a header
  // whose search table was not fully decoded.
  const pointerMismatch =
    sectionAddress !== undefined &&
    header.ehFramePointer !== null &&
    header.ehFramePointer !== sectionAddress;
  if (pointerMismatch) note(POINTER_MISMATCH);
  if (!header.decoded || header.status !== "present") return "unavailable";
  // Exact row-for-FDE bijection: equal counts and every table row claims a
  // distinct decoded FDE by offset with matching start address.
  if (pointerMismatch || header.rows.length !== ranges.length) {
    note(HEADER_MISMATCH, "eh_frame_hdr_mismatch");
    return "disagree";
  }
  const fdeStarts = new Map<number, bigint>();
  for (const range of ranges)
    fdeStarts.set(range.location.offset, range.startValue);
  if (fdeStarts.size !== ranges.length) {
    note(HEADER_MISMATCH, "eh_frame_hdr_mismatch");
    return "disagree";
  }
  for (const row of header.rows) {
    if (row.fdeFileOffset === null) {
      note(HEADER_MISMATCH, "eh_frame_hdr_mismatch");
      return "disagree";
    }
    const expectedStart = fdeStarts.get(row.fdeFileOffset);
    if (expectedStart === undefined || expectedStart !== row.startValue) {
      note(HEADER_MISMATCH, "eh_frame_hdr_mismatch");
      return "disagree";
    }
    fdeStarts.delete(row.fdeFileOffset);
  }
  return "agree";
};
