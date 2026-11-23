import {
  observeElfStringTableEntry,
  elfStringTableText,
} from "../elfStringTable.js";
import {
  mzWindowsHeaderLayoutLimitation,
  parseMzHeaderEvidence,
} from "../dosMz.js";
import { elfFixedHeaderWidth } from "../elfFixedHeader.js";
import { readElfSectionHeader } from "../elfSectionHeader.js";
import { readElfProgramHeader } from "../elfProgramHeader.js";
import { observePeCoffFrame, PE_COFF_FRAME_BYTES } from "../peCoffHeader.js";
import {
  PE_SECTION_HEADER_BYTES,
  peSectionTableExtent,
  readPeSectionHeader,
} from "../peSectionHeader.js";
import {
  readElfTableDeclarations,
  validateElfDeclaredRanges,
} from "../elfDeclaredRanges.js";
import { readPeOptionalHeaderStructure } from "../peOptionalHeader.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
  declaredFileRange,
  type ElfDynamicSegment,
} from "../binaryContainer.js";
import {
  decodeElfSectionNameRequest,
  decodeElfSectionNameRequestCooperative,
  elfSectionNameBudgetFailure,
  type CooperativeElfSectionNameDecoder,
  type ElfSectionNameDecodeRequest,
} from "./elfSectionNameTable.js";
import type { ElfCompressedSectionResult } from "./elfCompressedSection.js";
import type { ZstandardFramePause } from "../compression/zstandardExactFrame.js";
import {
  projectZstandardFrameAllowance,
  ZstandardFrameAllowanceError,
} from "../compression/zstandardFrameAllowance.js";

/** A borrowed positional source. Drivers own admission, cancellation and file identity. */
export interface NativeReadRequest {
  readonly offset: number;
  readonly size: number;
  /**
   * When set, the driver decodes this section-name table and calls
   * `fulfillSectionNames` before resuming. A byte read does not satisfy it.
   */
  readonly sectionNames?: ElfSectionNameDecodeRequest;
  readonly fulfillSectionNames?: (result: ElfCompressedSectionResult) => void;
}
export interface NativeSection {
  readonly index: number;
  readonly name: string | null;
  readonly name_state: "known" | "unavailable" | "truncated";
  readonly header_offset: number;
  readonly offset: bigint;
  readonly size: bigint;
  readonly address: bigint;
  readonly type: number;
  readonly flags: bigint;
  readonly link: number;
  readonly info: number;
  readonly entry_size: bigint;
  /** `sh_addralign` for ELF. PE sections have no note alignment and use 1. */
  readonly alignment: bigint;
  /** Declared stored bytes are present; compressed bytes are not decoded content. */
  readonly file_backed: boolean;
  /** ELF SHF_COMPRESSED storage encoding; always false for PE sections. */
  readonly compressed: boolean;
}
/** Program header types retained for load, dynamic, hardening, and unwind consumers. */
export const ELF_PT_NOTE = 4 as const;
export const ELF_PT_INTERP = 3 as const;
export const ELF_PT_GNU_EH_FRAME = 0x6474e550 as const;
export const ELF_PT_GNU_STACK = 0x6474e551 as const;
export const ELF_PT_GNU_RELRO = 0x6474e552 as const;
export const ELF_PT_GNU_PROPERTY = 0x6474e553 as const;

type ElfProgramSpan = {
  readonly header_offset: number;
  readonly flags: number;
  readonly file_offset: bigint;
  readonly file_size: bigint;
  readonly virtual_address: bigint;
  readonly memory_size: bigint;
  readonly alignment: bigint;
};

/** Raw relevant program declarations; consumers own load/dynamic admission. */
export type ElfProgramDeclaration =
  | ({ readonly type: 1 } & ElfProgramSpan)
  | ({ readonly type: 2; readonly header_offset: number } & ElfDynamicSegment)
  | ({ readonly type: typeof ELF_PT_NOTE } & ElfProgramSpan)
  | ({ readonly type: typeof ELF_PT_INTERP } & ElfProgramSpan)
  | ({ readonly type: typeof ELF_PT_GNU_EH_FRAME } & ElfProgramSpan)
  | ({ readonly type: typeof ELF_PT_GNU_STACK } & ElfProgramSpan)
  | ({ readonly type: typeof ELF_PT_GNU_RELRO } & ElfProgramSpan)
  | ({ readonly type: typeof ELF_PT_GNU_PROPERTY } & ElfProgramSpan);

export interface NativeSectionDirectory {
  readonly format: "elf" | "pe";
  readonly bits: 32 | 64;
  readonly little: boolean;
  readonly machine: number;
  readonly elf_os_abi: number | null;
  readonly flags: number;
  readonly section_names_limitation?: string;
  /** Raw COFF symbol table declarations, present only for PE. */
  readonly pe_symbol_table?: {
    readonly offset: number;
    readonly count: number;
  };
  readonly programs: readonly ElfProgramDeclaration[];
  readonly sections: readonly NativeSection[];
}
export type ElfSectionDirectory = NativeSectionDirectory & {
  readonly format: "elf";
  readonly elf_type: number;
};

const STRUCTURE_BYTES = 16 * 1024 * 1024;
const reject = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};
const requireSectionNames = (
  result: ElfCompressedSectionResult | undefined,
): ElfCompressedSectionResult => {
  if (result === undefined)
    return reject("ELF section-name decode was not satisfied");
  return result;
};
const exact = (value: bigint): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    reject("Native offset exceeds exact host precision");
  return Number(value);
};
const request = (
  fileSize: number,
  offset: bigint,
  size: bigint,
): NativeReadRequest => {
  if (
    offset < 0n ||
    size < 0n ||
    offset > BigInt(fileSize) ||
    size > BigInt(fileSize) - offset
  )
    reject("Native directory range is truncated or outside the file");
  if (size > BigInt(STRUCTURE_BYTES))
    throw new BinaryResourceFailure(
      "structure",
      STRUCTURE_BYTES,
      "Native directory exceeds the 16777216-byte (16 MiB) structural decoding budget. This release has no runtime override.",
      "structure",
      "bytes",
    );
  return { offset: exact(offset), size: exact(size) };
};

/** One ELF interpretation for in-memory images and bounded descriptor-backed inspections. */
export function* readElfSectionDirectory(
  fileSize: number,
  maximumSourceAndDecodedNamesBytes?: number,
): Generator<NativeReadRequest, ElfSectionDirectory, Buffer> {
  const prefix = yield request(fileSize, 0n, 16n);
  const headerSize = elfFixedHeaderWidth(prefix[4] === 1 ? 32 : 64);
  const bytes = yield request(fileSize, 0n, BigInt(headerSize));
  const parsed = yield* readElfTableDeclarations(bytes, fileSize);
  if (!parsed.ok) return reject(parsed.error);
  const { header, programs, sections: sectionTable } = parsed.value;
  const { elfClass: bits, byteOrder, machine } = header;
  const little = byteOrder === "little";
  const {
    offset: program_offset,
    width: program_width,
    count: program_count,
  } = programs;
  const {
    offset: sectionOffset,
    width: sectionWidth,
    count,
    namesIndex,
  } = sectionTable;
  const programDeclarations: ElfProgramDeclaration[] = [];
  if (program_count !== 0) {
    const programBytes = yield request(
      fileSize,
      program_offset,
      BigInt(program_count) * BigInt(program_width),
    );
    // At most one record per table entry, bounded before allocation by the
    // existing 16 MiB table allowance and minimum 32/56-byte ELF record width.
    for (let index = 0; index < program_count; index++) {
      const at = index * program_width;
      const parsedProgram = readElfProgramHeader(
        programBytes.subarray(at, at + program_width),
        bits,
        little,
      );
      if (!parsedProgram.ok) return reject(parsedProgram.error.message);
      const program = parsedProgram.value;
      const { type } = program;
      const header_offset = exact(program_offset) + at;
      const span = {
        header_offset,
        flags: program.flags,
        file_offset: program.offset,
        virtual_address: program.virtualAddress,
        file_size: program.fileSize,
        memory_size: program.memorySize,
        alignment: program.alignment,
      };
      if (type === 1) programDeclarations.push({ type, ...span });
      else if (type === 2)
        programDeclarations.push({
          type,
          header_offset,
          offset: program.offset,
          size: program.fileSize,
          virtual_address: program.virtualAddress,
        });
      else if (type === ELF_PT_NOTE)
        programDeclarations.push({ type: ELF_PT_NOTE, ...span });
      else if (type === ELF_PT_INTERP)
        programDeclarations.push({ type: ELF_PT_INTERP, ...span });
      else if (type === ELF_PT_GNU_EH_FRAME)
        programDeclarations.push({ type: ELF_PT_GNU_EH_FRAME, ...span });
      else if (type === ELF_PT_GNU_STACK)
        programDeclarations.push({ type: ELF_PT_GNU_STACK, ...span });
      else if (type === ELF_PT_GNU_RELRO)
        programDeclarations.push({ type: ELF_PT_GNU_RELRO, ...span });
      else if (type === ELF_PT_GNU_PROPERTY)
        programDeclarations.push({ type: ELF_PT_GNU_PROPERTY, ...span });
    }
  }
  const sections: NativeSection[] = [];
  let section_names_limitation: string | undefined;
  if (count !== 0) {
    const table = yield request(
      fileSize,
      sectionOffset,
      BigInt(count) * BigInt(sectionWidth),
    );
    let names: Buffer | null = null;
    if (namesIndex !== 0) {
      const h = namesIndex * sectionWidth;
      const parsedNames = readElfSectionHeader(
        table.subarray(h, h + sectionWidth),
        bits,
        little,
      );
      if (!parsedNames.ok) return reject(parsedNames.error.message);
      const namesSection = parsedNames.value;
      if (namesSection.type !== 3)
        reject("ELF section name table is not a string table");
      const rawNames = yield request(
        fileSize,
        namesSection.offset,
        namesSection.size,
      );
      const structuralRemaining = Math.max(
        0,
        STRUCTURE_BYTES - rawNames.length,
      );
      const callerRemaining =
        maximumSourceAndDecodedNamesBytes === undefined
          ? structuralRemaining
          : Math.max(0, maximumSourceAndDecodedNamesBytes - fileSize);
      let decoded: ElfCompressedSectionResult | undefined;
      const sectionNames: ElfSectionNameDecodeRequest = {
        raw: rawNames,
        flags: namesSection.flags,
        bits,
        little,
        maximumDecodedBytes: Math.min(structuralRemaining, callerRemaining),
      };
      yield {
        offset: 0,
        size: 0,
        sectionNames,
        fulfillSectionNames: (result) => {
          decoded = result;
        },
      };
      const admitted = requireSectionNames(decoded);
      if (admitted.state === "malformed") return reject(admitted.message);
      if (admitted.state === "configuration") throw admitted.error;
      if (admitted.state === "work_limit")
        throw new ZstandardFrameAllowanceError(
          { maxFrames: admitted.value, source: admitted.source },
          admitted.offset,
        );
      if (
        admitted.state === "limit" &&
        maximumSourceAndDecodedNamesBytes !== undefined &&
        admitted.requiredBytes > BigInt(callerRemaining)
      )
        throw elfSectionNameBudgetFailure(
          BigInt(fileSize) + admitted.requiredBytes,
          maximumSourceAndDecodedNamesBytes,
        );
      if (admitted.state === "limit")
        throw new BinaryResourceFailure(
          "structure",
          STRUCTURE_BYTES,
          `Decoded ELF section names require ${String(admitted.requiredBytes)} bytes, above the ${String(structuralRemaining)}-byte remaining structural budget`,
          "structure",
          "bytes",
        );
      if (admitted.state === "unsupported")
        section_names_limitation = `ELF section names are unavailable because compression type ${String(admitted.compressionType)} is unsupported`;
      else names = admitted.bytes;
    } else if (count > 1) {
      section_names_limitation =
        "ELF section names are unavailable because no section-name string table is declared";
    }
    const decodedNames = new Map<
      number,
      { name: string | null; state: NativeSection["name_state"] }
    >();
    let nameBytes = 0;
    for (let index = 0; index < count; index++) {
      const h = index * sectionWidth;
      const parsedSection = readElfSectionHeader(
        table.subarray(h, h + sectionWidth),
        bits,
        little,
      );
      if (!parsedSection.ok) return reject(parsedSection.error.message);
      const section = parsedSection.value;
      const nameOffset = section.nameOffset;
      let name: string | null = null;
      let name_state: NativeSection["name_state"] = "unavailable";
      if (names !== null) {
        let decoded = decodedNames.get(nameOffset);
        if (decoded === undefined) {
          const observed = observeElfStringTableEntry(names, nameOffset, 65536);
          nameBytes += observed.examinedBytes;
          if (nameBytes > STRUCTURE_BYTES)
            throw new BinaryResourceFailure(
              "structure",
              STRUCTURE_BYTES,
              "Decoded ELF section names exceed the 16 MiB structural budget",
              "structure",
              "bytes",
            );
          decoded = {
            name: elfStringTableText(observed),
            state:
              observed.state === "terminated"
                ? "known"
                : observed.state === "outside"
                  ? "unavailable"
                  : "truncated",
          };
          if (observed.state === "outside")
            section_names_limitation ??=
              "ELF section names are incomplete because a name offset is outside its string table";
          else if (observed.state === "truncated")
            section_names_limitation ??=
              "ELF section names are unavailable because a name is not NUL-terminated";
          if (observed.state !== "outside")
            decodedNames.set(nameOffset, decoded);
        }
        name_state = decoded.state;
        name = decoded.name;
      }
      const { type, offset, size } = section;
      sections.push({
        index,
        name,
        name_state,
        header_offset: exact(sectionOffset) + h,
        offset,
        size,
        address: section.address,
        type,
        flags: section.flags,
        link: section.link,
        info: section.info,
        entry_size: section.entrySize,
        alignment: section.alignment,
        file_backed:
          type !== 8 && declaredFileRange(fileSize, offset, size).file_backed,
        compressed: section.compressed,
      });
    }
  }
  return {
    format: "elf",
    elf_os_abi: header.osAbi,
    elf_type: header.type,
    bits,
    little,
    machine,
    flags: header.flags,
    ...(section_names_limitation === undefined
      ? {}
      : { section_names_limitation }),
    programs: programDeclarations,
    sections,
  };
}

export function* readPeSectionDirectory(
  fileSize: number,
): Generator<NativeReadRequest, NativeSectionDirectory, Buffer> {
  const dos = new BinaryReader(yield request(fileSize, 0n, 64n), true, "pe");
  if (dos.u16(0) !== 0x5a4d) reject("Missing DOS MZ header");
  const evidence = parseMzHeaderEvidence(dos.bytes, fileSize);
  const observed = evidence.windowsHeader;
  if (observed.state === "absent" || observed.state === "header-needed")
    return reject("MZ header does not declare a PE image");
  // A signature already observed in the DOS prefix establishes the layout
  // limitation even when the later COFF record is truncated.
  if (observed.state === "declared" && observed.signature === "PE") {
    const limitation = mzWindowsHeaderLayoutLimitation(observed);
    if (limitation !== undefined)
      throw new BinaryFormatFailure("unsupported", limitation);
  }
  const pe = observed.offset;
  // Native sections require a complete PE frame before decoding its fields.
  request(fileSize, BigInt(pe), BigInt(PE_COFF_FRAME_BYTES));
  const frame = yield* observePeCoffFrame(dos.bytes, fileSize, evidence);
  if (frame.kind !== "pe") return reject("PE signature is invalid");
  const limitation = mzWindowsHeaderLayoutLimitation(frame.observation);
  if (limitation !== undefined)
    throw new BinaryFormatFailure("unsupported", limitation);
  const { coff: parsedCoff } = frame;
  if (!parsedCoff.ok) return reject(parsedCoff.error.message);
  const {
    sectionCount: count,
    optionalHeaderSize: optionalSize,
    machine,
    characteristics,
    symbolTableOffset,
    symbolCount,
  } = parsedCoff.value;
  const optional = readPeOptionalHeaderStructure(
    yield request(
      fileSize,
      BigInt(pe + PE_COFF_FRAME_BYTES),
      BigInt(optionalSize),
    ),
  );
  if (!optional.ok) {
    switch (optional.error.reason) {
      case "truncated-magic":
        return reject("16-bit field range is truncated or outside the file");
      case "unsupported-magic":
        throw new BinaryFormatFailure(
          "unsupported",
          "Only PE32/PE32+ images are supported",
        );
      case "truncated-fixed-fields":
      case "truncated-directory-table":
        return reject("PE optional header or data directories are truncated");
    }
  }
  const { bits } = optional.value;
  const { sectionTableOffset, sectionTableBytes } = peSectionTableExtent(
    pe + PE_COFF_FRAME_BYTES,
    optionalSize,
    count,
  );
  const table = yield request(
    fileSize,
    BigInt(sectionTableOffset),
    BigInt(sectionTableBytes),
  );
  const sections: NativeSection[] = [];
  for (let index = 0; index < count; index++) {
    const at = index * PE_SECTION_HEADER_BYTES;
    const parsed = readPeSectionHeader(
      table.subarray(at, at + PE_SECTION_HEADER_BYTES),
    );
    if (!parsed.ok) return reject(parsed.error.message);
    const row = parsed.value;
    sections.push({
      index,
      name: row.name,
      name_state: "known",
      header_offset: sectionTableOffset + at,
      offset: BigInt(row.offset),
      size: BigInt(row.size),
      address: BigInt(row.virtual_address),
      type: 0,
      flags: BigInt(row.characteristics),
      link: 0,
      info: 0,
      entry_size: 0n,
      alignment: 1n,
      file_backed: declaredFileRange(
        fileSize,
        BigInt(row.offset),
        BigInt(row.size),
      ).file_backed,
      compressed: false,
    });
  }
  return {
    format: "pe",
    pe_symbol_table: { offset: symbolTableOffset, count: symbolCount },
    elf_os_abi: null,
    bits,
    little: true,
    machine,
    flags: characteristics,
    programs: [],
    sections,
  };
}

const resumeDirectoryStep = (
  bytes: Buffer,
  step: NativeReadRequest,
  names: (request: ElfSectionNameDecodeRequest) => ElfCompressedSectionResult,
): Buffer => {
  if (
    step.sectionNames !== undefined &&
    step.fulfillSectionNames !== undefined
  ) {
    step.fulfillSectionNames(names(step.sectionNames));
    return Buffer.alloc(0);
  }
  return bytes.subarray(step.offset, step.offset + step.size);
};

const driveFromBuffer = <T>(
  bytes: Buffer,
  steps: Generator<NativeReadRequest, T, Buffer>,
): T => {
  let next = steps.next();
  while (!next.done) {
    next = steps.next(
      resumeDirectoryStep(bytes, next.value, decodeElfSectionNameRequest),
    );
  }
  return next.value;
};

const driveElfDirectoryCooperative = async (
  bytes: Buffer,
  decode: CooperativeElfSectionNameDecoder,
  maximumSourceAndDecodedNamesBytes?: number,
): Promise<ElfSectionDirectory> => {
  const steps = readElfSectionDirectory(
    bytes.length,
    maximumSourceAndDecodedNamesBytes,
  );
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (
      step.sectionNames !== undefined &&
      step.fulfillSectionNames !== undefined
    ) {
      step.fulfillSectionNames(await decode(step.sectionNames));
      next = steps.next(Buffer.alloc(0));
      continue;
    }
    next = steps.next(bytes.subarray(step.offset, step.offset + step.size));
  }
  return next.value;
};

const projectDirectoryFrameAllowance = (
  operation: string,
  cause: unknown,
): never => {
  if (cause instanceof ZstandardFrameAllowanceError)
    throw projectZstandardFrameAllowance(operation, cause);
  throw cause;
};

/**
 * Borrow ELF bytes. `operation` names the public refusal when a compressed
 * section-name table exceeds `zstd.max_frames`, so every caller projects that
 * adjustable limit instead of an I/O or adapter failure.
 */
export const readElfDirectoryFromBuffer = (
  bytes: Buffer,
  operation: string,
  maximumSourceAndDecodedNamesBytes?: number,
): ElfSectionDirectory => {
  try {
    return driveFromBuffer(
      bytes,
      readElfSectionDirectory(bytes.length, maximumSourceAndDecodedNamesBytes),
    );
  } catch (cause) {
    return projectDirectoryFrameAllowance(operation, cause);
  }
};

/**
 * Same directory as {@link readElfDirectoryFromBuffer}. Compressed section
 * names yield through `pause` so the caller's abort signal can land.
 */
export const readElfDirectoryFromBufferCooperative = async (
  bytes: Buffer,
  pause: ZstandardFramePause,
  operation: string,
  maximumSourceAndDecodedNamesBytes?: number,
  decode: CooperativeElfSectionNameDecoder = (request) =>
    decodeElfSectionNameRequestCooperative(request, pause),
): Promise<ElfSectionDirectory> => {
  try {
    return await driveElfDirectoryCooperative(
      bytes,
      decode,
      maximumSourceAndDecodedNamesBytes,
    );
  } catch (cause) {
    return projectDirectoryFrameAllowance(operation, cause);
  }
};

/** Random-access byte source for positional native directory inspection. */
export interface NativeByteSource {
  readonly size: number;
  readonly prefix?: Buffer;
  readRange(offset: number, length: number): Promise<Buffer>;
}

const driveElfDirectoryFromSource = async (
  source: NativeByteSource,
  decode: CooperativeElfSectionNameDecoder,
  maximumSourceAndDecodedNamesBytes?: number,
): Promise<ElfSectionDirectory> => {
  const steps = readElfSectionDirectory(
    source.size,
    maximumSourceAndDecodedNamesBytes,
  );
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (
      step.sectionNames !== undefined &&
      step.fulfillSectionNames !== undefined
    ) {
      step.fulfillSectionNames(await decode(step.sectionNames));
      next = steps.next(Buffer.alloc(0));
      continue;
    }
    const slice =
      step.size === 0
        ? Buffer.alloc(0)
        : source.prefix !== undefined &&
            step.offset + step.size <= source.prefix.length
          ? source.prefix.subarray(step.offset, step.offset + step.size)
          : await source.readRange(step.offset, step.size);
    next = steps.next(slice);
  }
  return next.value;
};

/**
 * Same directory as {@link readElfDirectoryFromBufferCooperative}, reading only
 * the header, program/section tables, and section-name table from `source`.
 */
export const readElfDirectoryFromReader = async (
  source: NativeByteSource,
  pause: ZstandardFramePause,
  operation: string,
  maximumSourceAndDecodedNamesBytes?: number,
  decode: CooperativeElfSectionNameDecoder = (request) =>
    decodeElfSectionNameRequestCooperative(request, pause),
): Promise<ElfSectionDirectory> => {
  try {
    return await driveElfDirectoryFromSource(
      source,
      decode,
      maximumSourceAndDecodedNamesBytes,
    );
  } catch (cause) {
    return projectDirectoryFrameAllowance(operation, cause);
  }
};

/** Reject a program or section payload the declared tables place outside these bytes. */
export const assertElfDeclaredRangesFromBuffer = (bytes: Buffer): void => {
  const checked = driveFromBuffer(
    bytes,
    validateElfDeclaredRanges(bytes.subarray(0, 64), bytes.length),
  );
  if (!checked.ok) reject(checked.error);
};

/** Same declared-range check over a random-access source without buffering the full image. */
export const assertElfDeclaredRangesFromReader = async (
  source: NativeByteSource,
): Promise<void> => {
  const readSlice = async (offset: number, size: number): Promise<Buffer> => {
    if (size <= 0) return Buffer.alloc(0);
    if (source.prefix !== undefined && offset + size <= source.prefix.length)
      return source.prefix.subarray(offset, offset + size);
    return source.readRange(offset, size);
  };
  const header = await readSlice(0, Math.min(64, source.size));
  const steps = validateElfDeclaredRanges(header, source.size);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    next = steps.next(await readSlice(step.offset, step.size));
  }
  if (!next.value.ok) reject(next.value.error);
};
