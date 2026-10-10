import type { FileHandle } from "node:fs/promises";
import type {
  MipsAbiFlags,
  MipsElfMetadata,
} from "../domain/binaryTargetTypes.js";
import { err, ok, type Result } from "../domain/result.js";

/**
 * Read ELF32 MIPS ABI declarations from the caller's already-open file.
 * Inspect both typed tables (not section names), including records beyond the
 * initial header probe. A missing record is unknown, not a default FP ABI.
 * The caller supplies its cancellation check so its tagged error is preserved.
 */
export const readMipsElfAbiFlags = async (
  handle: FileHandle,
  metadata: MipsElfMetadata,
  checkCancelled: () => void,
): Promise<Result<MipsAbiFlags | null, string>> => {
  checkCancelled();
  if (metadata.elfClass !== 32)
    return err("MIPS ABI record inspection currently supports ELF32 only");
  const fileSize = (await handle.stat()).size;
  checkCancelled();
  const read = async (
    offset: number,
    length: number,
    label: string,
  ): Promise<Result<Buffer, string>> => {
    checkCancelled();
    if (
      !Number.isSafeInteger(fileSize) ||
      offset < 0 ||
      length < 0 ||
      offset > fileSize - length
    )
      return err(`MIPS ${label} lies outside the file`);
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
  const header = await read(0, 52, "ELF32 header");
  if (!header.ok) return header;
  const bytes = header.value;
  const little = metadata.byteOrder === "little";
  const u16 = (data: Buffer, offset: number): number =>
    little ? data.readUInt16LE(offset) : data.readUInt16BE(offset);
  const u32 = (data: Buffer, offset: number): number =>
    little ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
  if (
    bytes.toString("hex", 0, 4) !== "7f454c46" ||
    bytes[4] !== 1 ||
    bytes[5] !== (little ? 1 : 2) ||
    u16(bytes, 18) !== 8 ||
    u16(bytes, 16) !== metadata.type ||
    u32(bytes, 36) !== metadata.flags
  )
    return err("MIPS ELF header no longer matches the resolved identity");
  if (bytes[6] !== 1 || u32(bytes, 20) !== 1 || u16(bytes, 40) !== 52)
    return err("invalid MIPS ELF32 version or header size");

  const tables = [
    {
      label: "program header table",
      offset: u32(bytes, 28),
      count: u16(bytes, 44),
      stride: u16(bytes, 42),
      entrySize: 32,
      typeOffset: 0,
      dataOffset: 4,
      sizeOffset: 16,
      recordType: 0x70000003, // PT_MIPS_ABIFLAGS
    },
    {
      label: "section header table",
      offset: u32(bytes, 32),
      count: u16(bytes, 48),
      stride: u16(bytes, 46),
      entrySize: 40,
      typeOffset: 4,
      dataOffset: 16,
      sizeOffset: 20,
      recordType: 0x7000002a, // SHT_MIPS_ABIFLAGS
    },
  ];
  // Extended numbering needs a separate section-zero reader. Refuse it rather
  // than silently treating an unexamined table as having no ABI declarations.
  if (u16(bytes, 44) === 0xffff || u16(bytes, 48) >= 0xff00)
    return err("extended or reserved MIPS ELF table numbering is unsupported");
  let record: Buffer | undefined;
  for (const table of tables) {
    if (table.count === 0) {
      if (table.offset !== 0)
        return err(`unsupported extended or inconsistent MIPS ${table.label}`);
      continue;
    }
    if (table.offset < 52 || table.stride !== table.entrySize)
      return err(`invalid MIPS ${table.label} offset or entry size`);
    // Counts are bounded by the ELF16 fields and strides by their exact ELF32
    // structure sizes. Never allocate according to an untrusted section size.
    const contents = await read(
      table.offset,
      table.count * table.entrySize,
      table.label,
    );
    if (!contents.ok) return contents;
    let found = false;
    for (let i = 0; i < table.count; i += 1) {
      checkCancelled();
      const position = i * table.entrySize;
      if (u32(contents.value, position + table.typeOffset) !== table.recordType)
        continue;
      if (found) return err(`duplicate MIPS ABI records in ${table.label}`);
      found = true;
      const offset = u32(contents.value, position + table.dataOffset);
      const size = u32(contents.value, position + table.sizeOffset);
      if (size !== 24)
        return err("unsupported MIPS ABI record size; expected 24 bytes");
      const candidate = await read(offset, 24, "ABI record");
      if (!candidate.ok) return candidate;
      if (record !== undefined && !record.equals(candidate.value))
        return err("conflicting MIPS program/section ABI declarations");
      record = candidate.value;
    }
  }
  if (record === undefined) return ok(null);
  // Preserve declarations verbatim, including unknown versions/values. Provider
  // admission, not parsing, decides which interpretations have been verified.
  return ok({
    version: u16(record, 0),
    isaLevel: record.readUInt8(2),
    isaRevision: record.readUInt8(3),
    gprSize: record.readUInt8(4),
    cpr1Size: record.readUInt8(5),
    cpr2Size: record.readUInt8(6),
    fpAbi: record.readUInt8(7),
    isaExtension: u32(record, 8),
    ases: u32(record, 12),
    flags1: u32(record, 16),
    flags2: u32(record, 20),
  });
};
