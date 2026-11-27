import { LC } from "./machoLoadCommandCodes.js";
import type { FileMapping, ZeroFillMapping } from "../virtualFileMapping.js";
import { decodeMachoFixedName } from "./appleMachoNames.js";
import {
  machoSectionBacking,
  machoSectionHeaderSize,
  readMachoSectionHeader,
  type MachoSectionHeader,
} from "./machoSectionHeader.js";
import {
  admitMachoSegmentCommand,
  readMachoSegmentHeader,
} from "./machoSegmentHeader.js";
import {
  declaredFileRange,
  DEFAULT_NATIVE_STRUCTURE_BYTES,
  requireBinaryTableBudget,
  BinaryFormatFailure,
  BinaryReader,
  type BinaryContainer,
  type ImageSection,
  type LoadRegion,
  type MachoSegmentDeclaration,
} from "../binaryContainer.js";
import {
  MachoLoadCommandCursor,
  machoCommandTableIssue,
  readMachoLoadCommandDeclarations,
} from "./machoLoadCommands.js";
import { readByteSourceSlice, type ByteSource } from "../byteSource.js";

/** Read thin Mach-O images, retaining the slice's exact file-backed mappings. */
export const readMachoImage = (
  bytes: Buffer,
  structureBytes: number = DEFAULT_NATIVE_STRUCTURE_BYTES,
): Extract<BinaryContainer, { format: "macho" }> =>
  readMachoImageCore(bytes, bytes.length, structureBytes);

/** One framed load command handed to a reader's visitor during the shared walk. */
export interface MachoLoadCommandVisit {
  readonly command: number;
  readonly size: number;
  /** The whole command, `cmdsize` bytes from its `cmd` field. A view, not a copy. */
  readonly body: Buffer;
  /** Byte order of the image, so a visitor decodes fields without the result. */
  readonly littleEndian: boolean;
}

/**
 * Same thin Mach-O header and section read over a random-access source without
 * buffering the full image. `visit` sees every framed load command during the
 * one shared walk, so a consumer needing other commands does not walk again.
 */
export const readMachoImageFromReader = async (
  source: ByteSource,
  structureBytes: number = DEFAULT_NATIVE_STRUCTURE_BYTES,
  visit?: (command: MachoLoadCommandVisit) => void,
): Promise<Extract<BinaryContainer, { format: "macho" }>> => {
  const headerPrefix = await readByteSourceSlice(
    source,
    0,
    Math.min(32, source.size),
  );
  const parsed = readMachoLoadCommandDeclarations(headerPrefix, source.size);
  if (!parsed.ok) throw new BinaryFormatFailure("malformed", parsed.error);
  if (parsed.value === null)
    throw new BinaryFormatFailure("malformed", "Unrecognized Mach-O header");
  const table = parsed.value;
  const issue = machoCommandTableIssue(table, source.size);
  if (issue !== null)
    throw new BinaryFormatFailure(
      issue.kind === "extent" ? "truncated" : "malformed",
      issue.message,
      {
        format: "macho",
        field: "Mach-O load commands",
        offset: table.headerSize,
      },
    );
  requireBinaryTableBudget(
    BigInt(table.commandBytes),
    "Mach-O load commands",
    structureBytes,
  );
  const tableBytes = await readByteSourceSlice(
    source,
    0,
    table.headerSize + table.commandBytes,
  );
  return readMachoImageCore(tableBytes, source.size, structureBytes, visit);
};

const readMachoImageCore = (
  bytes: Buffer,
  fileBytes: number,
  structureBytes: number,
  visit?: (command: MachoLoadCommandVisit) => void,
): Extract<BinaryContainer, { format: "macho" }> => {
  const parsed = readMachoLoadCommandDeclarations(bytes, fileBytes);
  if (!parsed.ok) throw new BinaryFormatFailure("malformed", parsed.error);
  if (parsed.value === null)
    throw new BinaryFormatFailure("malformed", "Unrecognized Mach-O header");
  const table = parsed.value;
  const issue = machoCommandTableIssue(table, fileBytes);
  if (issue !== null)
    throw new BinaryFormatFailure(
      issue.kind === "extent" ? "truncated" : "malformed",
      issue.message,
      {
        format: "macho",
        field: "Mach-O load commands",
        offset: table.headerSize,
      },
    );
  const { headerSize, commandBytes, littleEndian: little } = table;
  const bits = table.wide ? 64 : 32;
  const reader = new BinaryReader(bytes, little, "macho");
  const commandStart = reader.table(
    BigInt(headerSize),
    commandBytes,
    1,
    "Mach-O load commands",
    structureBytes,
  );
  const mappings: FileMapping[] = [];
  const loadRegions: LoadRegion[] = [];
  const executableMappings: FileMapping[] = [];
  const zeroFills: ZeroFillMapping[] = [];
  const sections: ImageSection[] = [];
  const segmentDeclarations: MachoSegmentDeclaration[] = [];
  let chainedFixups = false;
  const commands = new MachoLoadCommandCursor(table);
  while (commands.nextOffset !== null) {
    const offset = commandStart + commands.nextOffset;
    const frame = commands.read(bytes.subarray(offset, offset + 8));
    if (!frame.ok) throw new BinaryFormatFailure("malformed", frame.error);
    const { command, size } = frame.value;
    visit?.({
      command,
      size,
      body: bytes.subarray(offset, offset + size),
      littleEndian: little,
    });
    if (command === LC.DYLD_CHAINED_FIXUPS) chainedFixups = true;
    if (command === LC.SEGMENT || command === LC.SEGMENT_64) {
      const wide = command === LC.SEGMENT_64;
      if (wide !== (bits === 64))
        throw new BinaryFormatFailure(
          "malformed",
          "Mach-O segment command does not match the header width",
        );
      const sectionWidth = machoSectionHeaderSize(wide);
      const parsedSegment = readMachoSegmentHeader(
        bytes.subarray(offset, offset + size),
        wide,
        little,
      );
      if (!parsedSegment.ok)
        throw new BinaryFormatFailure(
          parsedSegment.error.kind,
          parsedSegment.error.message,
        );
      const {
        headerSize: segmentHeader,
        memorySize,
        fileOffset,
        fileSize,
        maxProtection,
        protection,
        sectionCount,
        nameBytes,
      } = parsedSegment.value;
      const admitted = admitMachoSegmentCommand(
        parsedSegment.value,
        size,
        bits,
        fileBytes,
      );
      if (!admitted.ok)
        throw new BinaryFormatFailure(
          admitted.error.kind,
          admitted.error.message,
        );
      const { unmapped, fileAddress, zeroFill } = admitted.value;
      const fileRange =
        fileSize === 0n
          ? undefined
          : { offset: Number(fileOffset), size: Number(fileSize) };
      const mapping =
        unmapped || fileRange === undefined
          ? undefined
          : { ...fileRange, address: fileAddress };
      const name = decodeMachoFixedName(nameBytes);
      segmentDeclarations.push({
        name,
        address: parsedSegment.value.address,
        memory_size: memorySize,
        file_offset: fileOffset,
        file_size: fileSize,
        protection,
      });
      if (mapping !== undefined && name !== "__PAGEZERO") {
        mappings.push(mapping);
        loadRegions.push({
          mapping,
          memory_size: memorySize,
          read: (protection & 1) !== 0,
          write: (protection & 2) !== 0,
          execute: (protection & 4) !== 0,
          protection_masks: {
            current: protection,
            maximum: maxProtection,
          },
        });
        if ((protection & 4) !== 0) executableMappings.push(mapping);
      }
      if (zeroFill !== null && name !== "__PAGEZERO") zeroFills.push(zeroFill);
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
        const section = offset + segmentHeader + sectionIndex * sectionWidth;
        const parsedSection = readMachoSectionHeader(
          bytes.subarray(section, section + sectionWidth),
          wide,
          little,
        );
        if (!parsedSection.ok)
          throw new BinaryFormatFailure(
            parsedSection.error.kind,
            parsedSection.error.message,
          );
        sections.push(
          machoImageSection({
            fileBytes,
            section: parsedSection.value,
            protection,
            segmentMapping: mapping ?? null,
            segmentUnmapped: unmapped,
            unmapped: unmapped || mapping === undefined,
            segment: parsedSegment.value,
          }),
        );
      }
    }
  }
  const complete = commands.finish();
  if (!complete.ok) throw new BinaryFormatFailure("malformed", complete.error);
  const cpu = table.identity.cpuType;
  const names = new Map([
    [7, "386"],
    [0x01000007, "amd64"],
    [12, "arm"],
    [0x0100000c, "arm64"],
    [0x0200000c, "arm64_32"],
    [18, "ppc"],
    [0x01000012, "ppc64"],
  ]);
  return {
    format: "macho",
    macho_cpu_type: table.identity.cpuType,
    macho_file_type: table.fileType,
    macho_segments: segmentDeclarations,
    macho_chained_fixups: chainedFixups,
    architecture: names.get(cpu) ?? `macho-cpu-${cpu}`,
    bits,
    byte_order: little ? "little" : "big",
    mappings,
    load_regions: loadRegions,
    executable_mappings: executableMappings,
    zero_fills: zeroFills,
    sections,
  };
};

const machoImageSection = ({
  fileBytes,
  section,
  protection,
  segmentMapping,
  segmentUnmapped,
  unmapped,
  segment,
}: {
  readonly fileBytes: number;
  readonly section: MachoSectionHeader;
  readonly protection: number;
  readonly segmentMapping: FileMapping | null;
  readonly segmentUnmapped: boolean;
  readonly unmapped: boolean;
  readonly segment: Parameters<typeof machoSectionBacking>[1];
}): ImageSection => {
  const { flags, address: sectionAddress, size: sectionSize } = section;
  const sectionOffset = BigInt(section.offset);
  const sectionName = decodeMachoFixedName(section.nameBytes);
  const name = `${decodeMachoFixedName(section.segmentNameBytes)},${sectionName}`;
  const backing = machoSectionBacking(section, segment);
  const declaredRange = declaredFileRange(
    fileBytes,
    sectionOffset,
    sectionSize,
  );
  const range = unmapped
    ? { offset: 0, size: 0, file_backed: false }
    : declaredRange;
  const fileBacked = range.file_backed && backing.issue === null;
  const readOnly =
    fileBacked &&
    (protection & 1) !== 0 &&
    (protection & 2) === 0 &&
    (flags & 0x80000400) === 0;
  return {
    format: "macho",
    name,
    section_name: sectionName,
    type: flags & 0xff,
    flags,
    address: sectionAddress,
    declared_range: { offset: sectionOffset, size: sectionSize },
    segment_mapping: segmentMapping,
    segment_unmapped: segmentUnmapped,
    relocations: {
      offset: section.relocationOffset,
      count: section.relocationCount,
    },
    ...range,
    file_backed: fileBacked,
    on_disk: declaredRange.file_backed && backing.onDisk,
    read_only: readOnly,
    compressed: false,
  };
};
