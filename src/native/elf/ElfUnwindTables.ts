import { admitElfLoadSegment } from "../../domain/elfProgramHeader.js";
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readElfDynamicEntry } from "../../domain/elfDynamicEntry.js";
import { readElfSymbol } from "../../domain/elfSymbol.js";
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
  type ElfUnwindRanges,
  type InspectElfUnwindRangesInput,
} from "../../domain/native/elfUnwindRanges.js";
import { buildIntervalIndex } from "./ElfIntervalIndex.js";
import {
  ELF_PT_GNU_EH_FRAME,
  readElfDirectoryFromBuffer,
  type ElfProgramDeclaration,
  type NativeSection,
} from "../metadata/NativeSectionDirectory.js";

const DW_EH_PE_OMIT = 0xff;
/** CIE augmentation letters, compared as bytes. */
const AUG_Z = 0x7a;
const AUG_L = 0x4c;
const AUG_P = 0x50;
const AUG_R = 0x52;
const AUG_S = 0x53;
const AUG_B = 0x42;
const SHT_SYMTAB = 2;
const SHT_DYNAMIC = 6;
const SHT_NOBITS = 8;
const SHT_DYNSYM = 11;
const DT_NULL = 0n;
const DT_PLTGOT = 3n;
/** Bound on dynamic entries scanned for DT_PLTGOT. */
const MAX_DYNAMIC_ENTRIES = 4096;
const STT_NOTYPE = 0;
const STT_FUNC = 2;
const STT_GNU_IFUNC = 10;
const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;
const SHN_LORESERVE = 0xff00;
const SHF_ALLOC = 2n;
const SHF_EXECINSTR = 4n;
const SHF_COMPRESSED = 0x800n;

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

interface FunctionRange {
  readonly index: number;
  readonly start: string;
  readonly end: string;
  readonly size: string;
  readonly section: {
    readonly text: string;
    readonly trust: "untrusted";
  } | null;
  readonly symbol: {
    readonly text: string;
    readonly trust: "untrusted";
  } | null;
  readonly cie_index: number;
  readonly lsda: {
    readonly address: string;
    readonly indirect: boolean;
  } | null;
  readonly personality: {
    readonly address: string;
    readonly indirect: boolean;
  } | null;
  readonly location: FileRange;
  readonly startValue: bigint;
}

interface HeaderRow {
  readonly start: string;
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

/**
 * Symbol names for one page exceeded their fixed text allowance. Unlike the
 * record budgets, max_ranges does not raise it; a smaller page avoids it.
 */
export class ElfUnwindSymbolTextFailure extends Error {
  readonly maximumBytes = MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES;

  constructor() {
    super(
      `ELF unwind symbol names on this page exceed the ${String(MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES)}-byte symbol-name text allowance.`,
    );
    this.name = "ElfUnwindSymbolTextFailure";
  }
}

/** Read .eh_frame/.eh_frame_hdr function ranges. Truncation stays incomplete. */
export const parseElfUnwindRanges = (
  bytes: Buffer,
  artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  },
  input: InspectElfUnwindRangesInput,
  signal?: AbortSignal,
): ElfUnwindRanges => {
  assertArtifactReadActive(signal);
  const directory = readElfDirectoryFromBuffer(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = directory.little;
  const bits = directory.bits;
  const addressSize = bits === 64 ? 8 : 4;
  const limitations: string[] = [];
  let incomplete = false;
  let sawIndirect = false;
  const note = (text: string): void => {
    if (!limitations.includes(text)) limitations.push(text);
  };
  const fail = (text: string): void => {
    incomplete = true;
    note(text);
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
      program.file_offset + program.file_size > BigInt(bytes.length)
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

  const named = (name: string): NativeSection[] =>
    directory.sections.filter((section) => section.name === name);
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
    debugSection === undefined
      ? null
      : placeSection(debugSection, bytes.length);
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
    fail(DEBUG_OUTSIDE);
  }

  // In-file bytes of each SHF_ALLOC section; a section running past EOF keeps
  // its prefix. A non-ALLOC section's sh_addr is not a load address, so
  // translation falls through to PT_LOAD for bytes no ALLOC section maps.
  const mapped = directory.sections.flatMap((section) => {
    if ((section.flags & SHF_ALLOC) === 0n) return [];
    const location = placeSection(section, bytes.length).location;
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
    offset <= bytes.length &&
    size <= bytes.length - offset;
  const readU8 = (offset: number, end: number): number | null =>
    offset < end && offset < bytes.length ? (bytes[offset] ?? null) : null;
  const readU32 = (offset: number, end: number): number | null => {
    if (offset < 0 || offset + 4 > end || offset + 4 > bytes.length)
      return null;
    return view.getUint32(offset, little);
  };
  const readU64 = (offset: number, end: number): bigint | null => {
    if (offset < 0 || offset + 8 > end || offset + 8 > bytes.length)
      return null;
    return view.getBigUint64(offset, little);
  };
  const readS16 = (offset: number, end: number): number | null => {
    if (offset < 0 || offset + 2 > end || offset + 2 > bytes.length)
      return null;
    return view.getInt16(offset, little);
  };
  const readU16 = (offset: number, end: number): number | null => {
    if (offset < 0 || offset + 2 > end || offset + 2 > bytes.length)
      return null;
    return view.getUint16(offset, little);
  };
  const readS32 = (offset: number, end: number): number | null => {
    if (offset < 0 || offset + 4 > end || offset + 4 > bytes.length)
      return null;
    return view.getInt32(offset, little);
  };
  const readS64 = (offset: number, end: number): bigint | null => {
    if (offset < 0 || offset + 8 > end || offset + 8 > bytes.length)
      return null;
    return view.getBigInt64(offset, little);
  };
  const readLeb = (
    offset: number,
    end: number,
    signed: boolean,
  ): { readonly value: bigint; readonly next: number } | null => {
    let result = 0n;
    let shift = 0n;
    let pos = offset;
    let byte = 0;
    while (pos < end && pos < bytes.length && shift <= 63n) {
      byte = bytes[pos] ?? 0;
      pos += 1;
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if (signed && shift < 64n && (byte & 0x40) !== 0)
          result |= -1n << shift;
        return { value: result, next: pos };
      }
    }
    return null;
  };
  const safeInt = (value: bigint): number | null =>
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;

  let datarelMissing = false;
  let datarelUsed = false;
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
    const placement = placeSection(hdrSection, bytes.length);
    if (placement.problem !== null) {
      headerStatus = "incomplete";
      fail(
        placement.problem === "nobits"
          ? ".eh_frame_hdr is declared but not file-backed."
          : ".eh_frame_hdr extends past the end of the file and was not decoded.",
      );
    } else if ((hdrSection.flags & SHF_COMPRESSED) !== 0n) {
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

  const header =
    headerStatus === "present" && headerLocation !== null
      ? decodeHeader(
          headerLocation,
          hdrBase,
          textBaseAddress,
          readEncoded,
          readU8,
          safeInt,
          hex,
          fileOffsetForVa,
          fail,
          signal,
          { maxRows: input.max_ranges, addressSize },
        )
      : emptyHeader(headerStatus, headerLocation);

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
    const placement = placeSection(ehSection, bytes.length);
    frameLocation = placement.location;
    if (placement.problem === "nobits") {
      frameStatus = "incomplete";
      fail(".eh_frame is declared but not file-backed.");
    } else if (frameLocation === null) {
      frameStatus = "incomplete";
      fail(".eh_frame lies outside the file.");
    } else if ((ehSection.flags & SHF_COMPRESSED) !== 0n) {
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
      frameEnd = Math.min(end ?? bytes.length, bytes.length);
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
    note(FRAME_ABSENT);
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
  const gotBase = resolveGotBase(bytes, directory, named);
  datarelMissing = false;
  datarelUsed = false;

  const cies: CieRecord[] = [];
  const ranges: Array<Omit<FunctionRange, "section" | "symbol">> = [];
  const cieAt = new Map<number, CieRecord>();
  const rejectedCies = new Set<number>();
  let rejectedFdes = 0;
  let examined = 0;
  let cieRecords = 0;
  let fdeRecords = 0;
  let discarded = 0;
  let indirectFdes = 0;
  const budget = (kind: "CIE" | "FDE"): void => {
    throw new ArtifactReaderFailure(
      "limit",
      `ELF unwind ${kind} count exceeds the selected max_ranges budget of ${String(input.max_ranges)}.`,
      { boundary: "capacity" },
    );
  };

  if (frameStatus === "present" && frameLocation !== null) {
    let cursor = frameLocation.offset;
    const extent = frameEnd;
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
      const initialLength = readU32(cursor, extent);
      if (initialLength === null) {
        fail(".eh_frame ended inside a record.");
        frameStatus = "incomplete";
        break;
      }
      if (initialLength === 0) {
        const tail = bytes.subarray(cursor + 4, extent);
        if (scanPastTerminator && tail.some((byte) => byte !== 0))
          fail("Non-zero bytes follow the .eh_frame terminator.");
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
        const extended = readU64(cursor + 4, extent);
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
      const id = readU32(body, recordEnd);
      if (id === null) {
        fail(".eh_frame ended inside a record.");
        frameStatus = "incomplete";
        break;
      }
      const isCie = id === 0;
      if (isCie) {
        if (cieRecords + 1 > input.max_ranges) budget("CIE");
        cieRecords += 1;
      } else if (fdeRecords + 1 > input.max_ranges) budget("FDE");
      else fdeRecords += 1;
      examined += 1;
      let undecoded = false;
      if (isCie) {
        const cie = decodeCie({
          bytes,
          recordStart,
          recordEnd,
          body: body + idWidth,
          readU8,
          readLeb,
          readEncoded,
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
                  readLeb,
                  readEncoded,
                  hex,
                  safeInt,
                  datarel: gotBase?.address ?? null,
                  textrel: textBaseAddress,
                  addressBits: bits,
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

  const symbols = scanSymbols(
    bytes,
    directory,
    new Set(ranges.map((range) => range.startValue)),
    signal,
    { fail, note },
  );
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
  const withSymbols = ranges.filter((range) =>
    symbols.has(range.startValue),
  ).length;
  const decodeName = symbolNameDecoder();
  // Names are decoded only for the returned page.
  const pageRows = (
    input.offset >= ranges.length
      ? []
      : ranges.slice(input.offset, input.offset + input.limit)
  ).map((range) => {
    const symbol = symbols.get(range.startValue);
    const section = containingSection?.(range.startValue) ?? null;
    return {
      index: range.index,
      start: range.start,
      end: range.end,
      size: range.size,
      section:
        section?.name === null ||
        section?.name === undefined ||
        section.name.length === 0
          ? null
          : { text: section.name, trust: "untrusted" as const },
      symbol:
        symbol === undefined
          ? null
          : { text: decodeName(symbol), trust: "untrusted" as const },
      cie_index: range.cie_index,
      lsda: range.lsda,
      personality: range.personality,
      location: range.location,
    };
  });
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
    note(HEADER_ABSENT);
  note(CFA_LIMITATION);
  if (debugFrame.status === "present") note(DEBUG_PRESENT);
  else if (debugFrame.status === "absent") note(DEBUG_ABSENT);
  else if (debugFrame.status === "unknown") note(DEBUG_UNKNOWN);
  note(UNTRUSTED_LIMITATION);
  if (sawIndirect) note(INDIRECT_LIMITATION);

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
      status: incomplete ? "incomplete" : "complete",
      total_ranges: ranges.length,
      total_cies: cies.length,
      ranges_with_symbols: withSymbols,
      ranges_without_symbols: ranges.length - withSymbols,
      eh_frame_hdr_agreement: agreement,
      examined_records: examined,
    },
    limitations,
  };
  return returned;
};

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
 * `.got.plt` address, then the `.got` address. Null when none is declared.
 */
const resolveGotBase = (
  bytes: Buffer,
  directory: ReturnType<typeof readElfDirectoryFromBuffer>,
  named: (name: string) => NativeSection[],
): { readonly address: bigint; readonly source: string } | null => {
  const dynamicProgram = directory.programs.find(
    (program) => program.type === 2,
  );
  const dynamic =
    (dynamicProgram === undefined
      ? undefined
      : { offset: dynamicProgram.offset, fileSize: dynamicProgram.size }) ??
    directory.sections
      .filter((section) => section.type === SHT_DYNAMIC && section.file_backed)
      .map((section) => ({
        offset: section.offset,
        fileSize: section.size,
      }))[0];
  if (dynamic !== undefined) {
    const start = dynamic.offset;
    const end = dynamic.offset + dynamic.fileSize;
    if (start >= 0n && end <= BigInt(bytes.length)) {
      const limit = Number(end);
      const width = directory.bits === 64 ? 16 : 8;
      for (
        let at = Number(start), index = 0;
        at + width <= limit && index < MAX_DYNAMIC_ENTRIES;
        at += width, index += 1
      ) {
        const entry = readElfDynamicEntry(
          bytes.subarray(at, at + width),
          directory.bits,
          directory.little,
        );
        if (!entry.ok || entry.value.tag === DT_NULL) break;
        if (entry.value.tag === DT_PLTGOT && entry.value.value !== 0n)
          return { address: entry.value.value, source: "DT_PLTGOT" };
      }
    }
  }
  for (const name of [".got.plt", ".got"]) {
    const section = named(name).find(
      (candidate) => (candidate.flags & SHF_ALLOC) !== 0n,
    );
    if (section !== undefined && section.address !== 0n)
      return { address: section.address, source: `the ${name} section` };
  }
  return null;
};

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
      start: hex(start.address),
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

const decodeCie = (args: {
  readonly bytes: Buffer;
  readonly recordStart: number;
  readonly recordEnd: number;
  readonly body: number;
  readonly readU8: (offset: number, end: number) => number | null;
  readonly readLeb: (
    offset: number,
    end: number,
    signed: boolean,
  ) => { readonly value: bigint; readonly next: number } | null;
  readonly readEncoded: ReadEncoded;
  readonly safeInt: (value: bigint) => number | null;
  readonly encodingOf: (raw: number) => Encoding;
  readonly datarel: bigint | null;
  readonly textrel: bigint | null;
  readonly fail: (text: string) => void;
}): Omit<CieRecord, "index"> | "unknown-augmentation" | null => {
  const {
    bytes,
    recordStart,
    recordEnd,
    body,
    readU8,
    readLeb,
    readEncoded,
    safeInt,
    encodingOf,
    datarel,
    textrel,
    fail,
  } = args;
  const version = readU8(body, recordEnd);
  if (version === null) {
    fail("A CIE record is truncated.");
    return null;
  }
  let cursor = body + 1;
  // One bounded NUL search inside the record. The text stays a view of the
  // record bytes, so a long target-controlled augmentation is never built up
  // character by character.
  const terminator = bytes.subarray(cursor, recordEnd).indexOf(0);
  const augmentation = bytes.subarray(
    cursor,
    terminator < 0 ? recordEnd : cursor + terminator,
  );
  cursor = terminator < 0 ? recordEnd : cursor + terminator + 1;
  if (version !== 1 && version !== 3) {
    fail(`CIE version ${String(version)} is not decoded.`);
    return null;
  }
  const code = readLeb(cursor, recordEnd, false);
  if (code === null) {
    fail("A CIE record is truncated.");
    return null;
  }
  const data = readLeb(code.next, recordEnd, true);
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
    returnAddress = readU8(cursor, recordEnd);
    cursor += 1;
  } else {
    const register = readLeb(cursor, recordEnd, false);
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
    const length = readLeb(cursor, recordEnd, false);
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
      const raw = readU8(cursor, hasZ ? augEnd : recordEnd);
      if (raw === null) {
        fail("A CIE augmentation is truncated.");
        return null;
      }
      lsda = encodingOf(raw);
      cursor += 1;
    } else if (letter === AUG_P) {
      const raw = readU8(cursor, hasZ ? augEnd : recordEnd);
      if (raw === null) {
        fail("A CIE augmentation is truncated.");
        return null;
      }
      const encoded = readEncoded(cursor + 1, hasZ ? augEnd : recordEnd, raw, {
        datarel,
        textrel,
        funcrel: null,
        lengthOnly: false,
      });
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
      const raw = readU8(cursor, hasZ ? augEnd : recordEnd);
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
  readonly hex: (value: bigint) => string;
  readonly safeInt: (value: bigint) => number | null;
  readonly datarel: bigint | null;
  readonly textrel: bigint | null;
  readonly addressBits: 32 | 64;
  readonly fail: (text: string) => void;
}):
  | Omit<FunctionRange, "index" | "section" | "symbol">
  | "discarded"
  | "indirect"
  | null => {
  const {
    recordStart,
    recordEnd,
    body,
    cie,
    readLeb,
    readEncoded,
    hex,
    safeInt,
    datarel,
    textrel,
    addressBits,
    fail,
  } = args;
  const bases = {
    datarel,
    textrel,
    funcrel: null,
    lengthOnly: false as const,
  };
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
    { ...bases, lengthOnly: true },
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
  let lsda: FunctionRange["lsda"] = null;
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
        lsda = { address: hex(encoded.address), indirect: encoded.indirect };
    }
    cursor = augEnd;
  }
  if (cursor > recordEnd) {
    fail("An FDE record is truncated.");
    return null;
  }
  // pc_begin + pc_range wraps at the address width, as in libgcc.
  const end = BigInt.asUintN(addressBits, start.address + length.address);
  return {
    start: hex(start.address),
    end: hex(end),
    size: length.address.toString(),
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
  };
};

/** A readable, non-empty symbol name still held as string-table bytes. */
type SymbolName = Extract<ElfStringTableObservation, { state: "terminated" }>;

/**
 * Exact-start symbol names for the FDE starts in `wanted`. Each name stays a
 * view of the string table: text is decoded later, only for returned rows.
 * Observations are cached per table and name offset, so a name shared by many
 * symbols is scanned once and decoded at most once.
 */
const scanSymbols = (
  bytes: Buffer,
  directory: ReturnType<typeof readElfDirectoryFromBuffer>,
  wanted: ReadonlySet<bigint>,
  signal: AbortSignal | undefined,
  report: {
    readonly fail: (text: string) => void;
    readonly note: (text: string) => void;
  },
): Map<bigint, SymbolName> => {
  const { fail, note } = report;
  const found = new Map<
    bigint,
    {
      readonly name: SymbolName;
      readonly score: number;
      readonly ifunc: boolean;
    }
  >();
  const tables = directory.sections.filter(
    (section) => section.type === SHT_SYMTAB || section.type === SHT_DYNSYM,
  );
  const standard = directory.bits === 64 ? 24 : 16;
  // First section per index, matching a directory-order find.
  const byIndex = new Map<number, NativeSection>();
  for (const section of directory.sections)
    if (!byIndex.has(section.index)) byIndex.set(section.index, section);
  // One budget across .symtab and .dynsym together.
  let remaining = MAX_ELF_UNWIND_SYMBOLS;
  for (const table of tables) {
    assertArtifactReadActive(signal);
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
    let count = Math.floor(size / width);
    if (count > remaining) {
      fail(
        `Symbol tables were capped at ${String(MAX_ELF_UNWIND_SYMBOLS)} combined entries.`,
      );
      count = remaining;
    }
    remaining -= count;
    const strings = byIndex.get(table.link);
    const stringBytes =
      strings !== undefined && strings.file_backed
        ? bytes.subarray(
            Number(strings.offset),
            Number(strings.offset + strings.size),
          )
        : null;
    if (stringBytes === null) fail("A symbol string table could not be read.");
    // Observation per string-table offset; null when the name is unreadable.
    const names = new Map<number, SymbolName | null>();
    for (let index = 0; index < count; index += 1) {
      assertArtifactReadActive(signal);
      const parsed = readElfSymbol(
        bytes.subarray(start + index * width, start + (index + 1) * width),
        directory.bits,
        directory.little,
      );
      if (!parsed.ok) {
        fail("A symbol record is truncated.");
        break;
      }
      const symbol = parsed.value;
      if (
        symbol.type !== STT_FUNC &&
        symbol.type !== STT_GNU_IFUNC &&
        symbol.type !== STT_NOTYPE
      )
        continue;
      if (symbol.section_index === SHN_UNDEF) continue;
      if (
        symbol.section_index >= SHN_LORESERVE &&
        symbol.section_index !== SHN_ABS
      )
        continue;
      let address = symbol.value;
      if (directory.elf_type === 1 && symbol.section_index !== SHN_ABS) {
        const owner = byIndex.get(symbol.section_index);
        if (owner !== undefined) address += owner.address;
      }
      // Only a symbol at a decoded FDE start can name a range.
      if (stringBytes === null || !wanted.has(address)) continue;
      let name = names.get(symbol.name_offset);
      if (name === undefined) {
        const observed = observeElfStringTableEntry(
          stringBytes,
          symbol.name_offset,
          65536,
        );
        name = observed.state === "terminated" ? observed : null;
        names.set(symbol.name_offset, name);
      }
      if (name === null) {
        fail("A symbol name could not be read.");
        continue;
      }
      if (name.contentBytes === 0) continue;
      // A function symbol is preferred, then an IFUNC resolver, then an
      // untyped label; .symtab breaks ties.
      const score =
        (symbol.type === STT_FUNC ? 4 : symbol.type === STT_GNU_IFUNC ? 2 : 0) +
        (table.type === SHT_SYMTAB ? 1 : 0);
      const previous = found.get(address);
      if (previous === undefined || score > previous.score)
        found.set(address, {
          name,
          score,
          ifunc: symbol.type === STT_GNU_IFUNC,
        });
    }
  }
  if ([...found.values()].some((item) => item.ifunc)) note(IFUNC_NAMES);
  return new Map([...found].map(([address, item]) => [address, item.name]));
};

/**
 * Decode returned symbol names once each, charging their text against a fixed
 * allowance before converting it.
 */
const symbolNameDecoder = (): ((name: SymbolName) => string) => {
  const decoded = new Map<SymbolName, string>();
  let charged = 0;
  return (name) => {
    const cached = decoded.get(name);
    if (cached !== undefined) return cached;
    charged += name.contentBytes;
    if (charged > MAX_ELF_UNWIND_SYMBOL_TEXT_BYTES)
      throw new ElfUnwindSymbolTextFailure();
    const text = elfStringTableText(name) ?? "";
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
  ranges: readonly { readonly start: string; readonly location: FileRange }[],
  sectionAddress: bigint | undefined,
  note: (text: string) => void,
): "agree" | "disagree" | "unavailable" => {
  // The only owner of the eh_frame_ptr check; it also runs for a header
  // whose search table was not fully decoded.
  const pointerMismatch =
    sectionAddress !== undefined &&
    header.ehFramePointer !== null &&
    header.ehFramePointer !== sectionAddress;
  if (pointerMismatch) note(POINTER_MISMATCH);
  if (!header.decoded || header.status !== "present") return "unavailable";
  // Exact row-for-FDE agreement: equal start multisets, and every table row
  // names a distinct decoded FDE with that same start.
  const sorted = (values: readonly string[]): string[] =>
    values
      .map((value) => BigInt(value))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((value) => value.toString(16));
  const starts = sorted(ranges.map((range) => range.start));
  const tableStarts = sorted(header.rows.map((row) => row.start));
  const sameStarts =
    starts.length === tableStarts.length &&
    starts.every((start, index) => start === tableStarts[index]);
  const fdeStarts = new Map(
    ranges.map((range) => [range.location.offset, range.start] as const),
  );
  const claimed = new Set<number>();
  const pointersLand = header.rows.every((row) => {
    if (row.fdeFileOffset === null || claimed.has(row.fdeFileOffset))
      return false;
    claimed.add(row.fdeFileOffset);
    return fdeStarts.get(row.fdeFileOffset) === row.start;
  });
  if (sameStarts && pointersLand && !pointerMismatch) return "agree";
  note(HEADER_MISMATCH);
  return "disagree";
};
