import {
  elfSectionHeaderWidth,
  readElfSectionHeader,
} from "../domain/elfSectionHeader.js";
import {
  elfProgramHeaderWidth,
  readElfProgramHeader,
  type ElfProgramHeader,
} from "../domain/elfProgramHeader.js";
import { readElfRawTableDeclarations } from "../domain/elfRawTableDeclarations.js";
import { isElfRelocationSectionType } from "../domain/elfRelocation.js";
import type { FileHandle } from "node:fs/promises";
import { BinaryReader } from "../domain/binaryContainer.js";
import {
  mipsLimitationMessages,
  type MipsAbiFlags,
  type MipsElfLimitation,
  type MipsElfMetadata,
  type MipsGnuAttributes,
} from "../domain/binaryTargetTypes.js";
import {
  elfFixedHeaderWidth,
  readElfFixedHeader,
} from "../domain/elfFixedHeader.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readMipsElfSharedLoad,
  type MipsElfRelocationSection,
} from "./MipsElfSharedLoad.js";
import { parseMipsGnuAttributes } from "./MipsGnuAttributes.js";

const SHT_GNU_ATTRIBUTES = 0x6ffffff5;
const MIPS_GNU_ATTRIBUTES_MAX_BYTES = 4096;

/** Observed ABI and load declarations, retaining unavailable source coverage. */
export interface MipsElfInspection {
  readonly abiFlags: MipsAbiFlags | null;
  readonly gnuAttributes: MipsGnuAttributes | null;
  readonly limitations: readonly MipsElfLimitation[];
  readonly sharedLoad?: MipsElfMetadata["sharedLoad"];
}

/**
 * Build the bounded whole-region reader used for every declaration source.
 * The caller supplies its cancellation check so its tagged error is preserved.
 */
const createMipsRegionReader = (
  handle: FileHandle,
  fileSize: number,
  checkCancelled: () => void,
) => {
  const read = async (
    offset: number,
    length: number,
    label: string,
    maxBytes?: number,
  ): Promise<Result<Buffer, string>> => {
    checkCancelled();
    if (
      !Number.isSafeInteger(fileSize) ||
      offset < 0 ||
      length < 0 ||
      offset > fileSize - length
    )
      return err(`MIPS ${label} lies outside the file`);
    if (maxBytes !== undefined && (length === 0 || length > maxBytes))
      return err(
        `MIPS ${label} size ${length} is outside REA's inspected bound of ${maxBytes} bytes`,
      );
    const bytes = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      checkCancelled();
      const observed = await handle.read(
        bytes,
        total,
        length - total,
        offset + total,
      );
      checkCancelled();
      if (observed.bytesRead === 0) return err(`truncated MIPS ${label}`);
      total += observed.bytesRead;
    }
    return ok(bytes);
  };
  return read;
};

/**
 * Read ELF32 MIPS ABI and shared-load declarations from the caller's already-open file.
 * Inspect both typed tables (not section names), including records beyond the
 * initial header probe. A missing record is unknown, not a default FP ABI.
 * The caller supplies its cancellation check so its tagged error is preserved.
 */
export const readMipsElfMetadata = async (
  handle: FileHandle,
  metadata: MipsElfMetadata,
  checkCancelled: () => void,
): Promise<Result<MipsElfInspection, string>> => {
  checkCancelled();
  if (metadata.elfClass !== 32)
    return err("MIPS ABI record inspection currently supports ELF32 only");
  const fileSize = (await handle.stat()).size;
  checkCancelled();
  const read = createMipsRegionReader(handle, fileSize, checkCancelled);
  const header = await read(0, 52, "ELF32 header");
  if (!header.ok) return header;
  const bytes = header.value;
  const fixedHeader = readElfFixedHeader(bytes, fileSize);
  if (!fixedHeader.ok) return fixedHeader;
  const little = metadata.byteOrder === "little";
  if (
    fixedHeader.value.elfClass !== 32 ||
    fixedHeader.value.byteOrder !== metadata.byteOrder ||
    fixedHeader.value.machine !== 8 ||
    fixedHeader.value.type !== metadata.type ||
    fixedHeader.value.flags !== metadata.flags
  )
    return err("MIPS ELF header no longer matches the resolved identity");
  const headerWidth = elfFixedHeaderWidth(32);
  if (fixedHeader.value.headerSize !== headerWidth)
    return err("invalid MIPS ELF32 version or header size");

  const raw = readElfRawTableDeclarations(bytes, fixedHeader.value);
  if (!raw.ok) return err(raw.error.message);
  const { programs, sections } = raw.value;
  const tables = [
    {
      label: "program header table",
      offset: Number(programs.offset),
      count: programs.count,
      stride: programs.width,
      entrySize: elfProgramHeaderWidth(32),
      recordType: 0x70000003, // PT_MIPS_ABIFLAGS
      optional: false,
    },
    {
      label: "section header table",
      offset: Number(sections.offset),
      count: sections.count,
      stride: sections.width,
      entrySize: elfSectionHeaderWidth(32),
      recordType: 0x7000002a, // SHT_MIPS_ABIFLAGS
      optional: true,
    },
  ];
  // Extended numbering needs a separate section-zero reader. Refuse it rather
  // than silently treating an unexamined table as having no ABI declarations.
  if (programs.count === 0xffff || sections.count >= 0xff00)
    return err("extended or reserved MIPS ELF table numbering is unsupported");
  let record: Buffer | undefined;
  let sharedLoad: MipsElfMetadata["sharedLoad"];
  let programHeaders: ElfProgramHeader[] | undefined;
  const relocationSections: MipsElfRelocationSection[] = [];
  const limitations: MipsElfLimitation[] = [];
  let gnuAttributes: MipsGnuAttributes | null = null;
  for (const table of tables) {
    if (table.count === 0) {
      if (table.offset !== 0)
        return err(`unsupported extended or inconsistent MIPS ${table.label}`);
      continue;
    }
    if (table.offset < headerWidth || table.stride !== table.entrySize)
      return err(`invalid MIPS ${table.label} offset or entry size`);
    const count = table.optional
      ? Math.min(
          table.count,
          Math.max(0, Math.floor((fileSize - table.offset) / table.entrySize)),
        )
      : table.count;
    if (count < table.count)
      limitations.push({
        kind: "truncated_section_table",
        offset: table.offset,
        examined: count,
        declared: table.count,
        message: `MIPS ${table.label} at file offset ${table.offset} extends beyond the captured file: examined ${count} of ${table.count} complete headers. ABI declarations in unavailable headers remain unknown.`,
      });
    if (count === 0) continue;
    // Counts are bounded by the ELF16 fields and strides by their exact ELF32
    // structure sizes. Never allocate according to an untrusted section size.
    const contents = await read(
      table.offset,
      count * table.entrySize,
      table.label,
    );
    if (!contents.ok) return contents;
    if (!table.optional && metadata.type === 3) programHeaders = [];
    let found = false;
    for (let i = 0; i < count; i += 1) {
      checkCancelled();
      const position = i * table.entrySize;
      const parsedRecord = table.optional
        ? readElfSectionHeader(
            contents.value.subarray(position, position + table.entrySize),
            32,
            little,
          )
        : readElfProgramHeader(
            contents.value.subarray(position, position + table.entrySize),
            32,
            little,
          );
      if (!parsedRecord.ok) return err(parsedRecord.error.message);
      const declaration = parsedRecord.value;
      if ("fileSize" in declaration) programHeaders?.push(declaration);
      const { type } = declaration;
      const declaredOffset = Number(declaration.offset);
      const declaredSize = Number(
        "fileSize" in declaration ? declaration.fileSize : declaration.size,
      );
      if (
        "compressed" in declaration &&
        declaration.compressed &&
        (type === table.recordType || type === SHT_GNU_ATTRIBUTES)
      )
        return err(
          `MIPS section header ${i} declares compressed ${type === SHT_GNU_ATTRIBUTES ? "GNU attributes" : "ABI flags"} at file offset ${declaredOffset}; decoded declarations are unavailable`,
        );
      if (table.optional && type === SHT_GNU_ATTRIBUTES) {
        if (gnuAttributes !== null)
          return err("duplicate MIPS GNU attribute sections");
        const section = await read(
          declaredOffset,
          declaredSize,
          "GNU attribute section",
          MIPS_GNU_ATTRIBUTES_MAX_BYTES,
        );
        if (!section.ok) return section;
        const parsed = parseMipsGnuAttributes(section.value, little);
        if (!parsed.ok) return parsed;
        gnuAttributes = parsed.value;
        continue;
      }
      if (
        metadata.type === 3 &&
        "entrySize" in declaration &&
        isElfRelocationSectionType(type)
      )
        relocationSections.push({
          type,
          offset: declaredOffset,
          size: declaredSize,
          entrySize: Number(declaration.entrySize),
          compressed: declaration.compressed,
        });
      if (type !== table.recordType) continue;
      if (found) return err(`duplicate MIPS ABI records in ${table.label}`);
      found = true;
      const offset = declaredOffset;
      const size = declaredSize;
      if (size !== 24)
        return err("unsupported MIPS ABI record size; expected 24 bytes");
      const candidate = await read(offset, 24, "ABI record");
      if (!candidate.ok) return candidate;
      if (record !== undefined && !record.equals(candidate.value))
        return err("conflicting MIPS program/section ABI declarations");
      record = candidate.value;
    }
  }
  if (metadata.type === 3 && programHeaders !== undefined) {
    if (limitations.length > 0)
      sharedLoad = {
        status: "unavailable",
        reason: `MIPS shared-image relocation declaration sources are incomplete. ${mipsLimitationMessages(limitations).join(" ")}`,
      };
    else {
      const shared = await readMipsElfSharedLoad(
        programHeaders,
        little,
        fileSize,
        read,
        checkCancelled,
        relocationSections,
      );
      sharedLoad = shared.ok
        ? shared.value
        : { status: "unavailable", reason: shared.error };
    }
  }
  const shared =
    metadata.type === 3
      ? {
          sharedLoad: sharedLoad ?? {
            status: "unavailable" as const,
            reason: "MIPS shared image has no inspected program header table",
          },
        }
      : {};
  if (record === undefined)
    return ok({ abiFlags: null, gnuAttributes, limitations, ...shared });
  // Preserve declarations verbatim, including unknown versions/values. Provider
  // admission, not parsing, decides which interpretations have been verified.
  const reader = new BinaryReader(record, little, "mips-abi-flags");
  const abiFlags: MipsAbiFlags = {
    version: reader.u16(0),
    isaLevel: reader.u8(2),
    isaRevision: reader.u8(3),
    gprSize: reader.u8(4),
    cpr1Size: reader.u8(5),
    cpr2Size: reader.u8(6),
    fpAbi: reader.u8(7),
    isaExtension: reader.u32(8),
    ases: reader.u32(12),
    flags1: reader.u32(16),
    flags2: reader.u32(20),
  };
  if (
    gnuAttributes !== null &&
    gnuAttributes.fpAbi !== null &&
    gnuAttributes.fpAbi !== 0 &&
    gnuAttributes.fpAbi !== abiFlags.fpAbi
  )
    return err(
      "conflicting MIPS ABI flags and GNU floating-point ABI declarations",
    );
  return ok({ abiFlags, gnuAttributes, limitations, ...shared });
};
