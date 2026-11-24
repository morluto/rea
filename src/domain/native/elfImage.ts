import type { FileMapping, ZeroFillMapping } from "../virtualFileMapping.js";
import { admitElfLoadSegment, elfLoadSpans } from "../elfProgramHeader.js";
import {
  declaredFileRange,
  BinaryFormatFailure,
  type BinaryContainer,
  type ElfDynamicSegment,
  type ImageSection,
  type LoadRegion,
} from "../binaryContainer.js";
import { elfArchitecture } from "../elfFixedHeader.js";
import type { ZstandardFramePause } from "../compression/zstandardExactFrame.js";
import type { CooperativeElfSectionNameDecoder } from "./elfSectionNameTable.js";
import {
  readElfDirectoryFromBuffer,
  readElfDirectoryFromBufferCooperative,
  readElfDirectoryFromReader,
  type ElfSectionDirectory,
} from "./nativeSectionDirectory.js";
import type { ByteSource } from "../byteSource.js";

const requireElfFileRange = (
  fileSize: number,
  offset: bigint,
  size: bigint,
  label: string,
): void => {
  const end = BigInt(fileSize);
  const message = `${label} range is outside the file`;
  if (offset < 0n || offset > end)
    throw new BinaryFormatFailure("malformed", message, {
      format: "elf",
      field: label,
      ...(offset >= BigInt(Number.MIN_SAFE_INTEGER) &&
      offset <= BigInt(Number.MAX_SAFE_INTEGER)
        ? { offset: Number(offset) }
        : {}),
    });
  if (size > end - offset)
    throw new BinaryFormatFailure("truncated", message, {
      format: "elf",
      field: label,
      offset: Number(offset),
    });
};

export const readElfImageFromDirectorySize = (
  fileSize: number,
  directory: ElfSectionDirectory,
): Extract<BinaryContainer, { format: "elf" }> => {
  const { bits } = directory;
  const mappings: FileMapping[] = [];
  const loadRegions: LoadRegion[] = [];
  const executableMappings: FileMapping[] = [];
  const zeroFills: ZeroFillMapping[] = [];
  const sections: ImageSection[] = [];
  const dynamicSegments: ElfDynamicSegment[] = [];
  for (const program of directory.programs) {
    if (program.type === 2) {
      dynamicSegments.push(program);
      continue;
    }
    // PT_INTERP and GNU program headers are not load segments.
    if (program.type !== 1) continue;
    const {
      flags,
      file_offset: fileOffset,
      virtual_address: address,
      file_size: size,
      memory_size: memorySize,
    } = program;
    const span = {
      virtualAddress: address,
      offset: fileOffset,
      memorySize,
      fileSize: size,
    };
    const admitted = admitElfLoadSegment(span, bits);
    if (!admitted.ok)
      throw new BinaryFormatFailure("malformed", admitted.error.message);
    if (size !== 0n)
      requireElfFileRange(fileSize, fileOffset, size, "ELF load segment");
    const { fileBacked: mapping, zeroFill } = elfLoadSpans(span);
    if (mapping !== undefined) {
      mappings.push(mapping);
      loadRegions.push({
        mapping,
        memory_size: memorySize,
        read: (flags & 4) !== 0,
        write: (flags & 2) !== 0,
        execute: (flags & 1) !== 0,
      });
      if ((flags & 1) !== 0) executableMappings.push(mapping);
    }
    if (zeroFill !== undefined) zeroFills.push(zeroFill);
  }
  for (const section of directory.sections) {
    const range = declaredFileRange(fileSize, section.offset, section.size);
    const { file_backed, compressed } = section;
    const read_only =
      section.type === 1 &&
      file_backed &&
      !compressed &&
      (section.flags & 1n) === 0n &&
      (section.flags & 4n) === 0n &&
      (section.flags & 2n) !== 0n;
    if ((section.name === null || section.name === "") && !read_only) continue;
    sections.push({
      format: "elf",
      name: section.name,
      type: section.type,
      flags: section.flags,
      address: section.address,
      declared_range: { offset: section.offset, size: section.size },
      ...range,
      file_backed,
      compressed,
      read_only,
    });
  }
  return {
    format: "elf",
    elf: {
      machine: directory.machine,
      type: directory.elf_type,
      dynamicSegments,
    },
    architecture: architectureForElfMachine(directory.machine),
    bits,
    byte_order: directory.little ? "little" : "big",
    mappings,
    load_regions: loadRegions,
    executable_mappings: executableMappings,
    zero_fills: zeroFills,
    sections,
    ...(directory.section_names_limitation === undefined
      ? {}
      : { section_names_limitation: directory.section_names_limitation }),
  };
};

export const readElfImageFromDirectory = (
  bytes: Buffer,
  directory: ElfSectionDirectory,
): Extract<BinaryContainer, { format: "elf" }> =>
  readElfImageFromDirectorySize(bytes.length, directory);

/** Map ELF machine identifiers to stable architecture names. */
export const architectureForElfMachine = (machine: number): string => {
  const architecture = elfArchitecture(machine);
  if (architecture !== undefined) {
    switch (architecture) {
      case "x86":
        return "386";
      case "x86_64":
        return "amd64";
      case "powerpc":
        return "ppc";
      default:
        return architecture;
    }
  }
  switch (machine) {
    case 21:
      return "ppc64";
    case 22:
      return "s390";
    case 258:
      return "loongarch";
    default:
      return `elf-machine-${machine}`;
  }
};

/** Read ELF sections and file-backed program mappings without interpreting language metadata. */
export const readElfImage = (
  bytes: Buffer,
  operation: string,
  maximumSourceAndDecodedNamesBytes?: number,
): Extract<BinaryContainer, { format: "elf" }> =>
  readElfImageFromDirectory(
    bytes,
    readElfDirectoryFromBuffer(
      bytes,
      operation,
      maximumSourceAndDecodedNamesBytes,
    ),
  );

/** Same image as {@link readElfImage}. Section names yield through `pause`. */
export const readElfImageCooperative = async (
  bytes: Buffer,
  operation: string,
  pause: ZstandardFramePause,
  maximumSourceAndDecodedNamesBytes?: number,
  decode?: CooperativeElfSectionNameDecoder,
): Promise<Extract<BinaryContainer, { format: "elf" }>> =>
  readElfImageFromDirectorySize(
    bytes.length,
    await readElfDirectoryFromBufferCooperative(
      bytes,
      pause,
      operation,
      maximumSourceAndDecodedNamesBytes,
      decode,
    ),
  );

/** Read ELF sections and program mappings positionally without buffering the whole file. */
export const readElfImageFromReader = async (
  source: ByteSource,
  operation: string,
  pause: ZstandardFramePause,
  maximumSourceAndDecodedNamesBytes?: number,
  decode?: CooperativeElfSectionNameDecoder,
): Promise<Extract<BinaryContainer, { format: "elf" }>> =>
  readElfImageFromDirectorySize(
    source.size,
    await readElfDirectoryFromReader(
      source,
      pause,
      operation,
      maximumSourceAndDecodedNamesBytes,
      decode,
    ),
  );
