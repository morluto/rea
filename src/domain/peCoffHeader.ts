import { BinaryReader } from "./binaryContainer.js";
import { err, ok } from "./result.js";

/** Fixed 20-byte COFF record, excluding the PE signature; callers own admission. */
export const readPeCoffHeader = (bytes: Buffer) => {
  if (bytes.length < 20)
    return err({
      kind: "malformed" as const,
      message: "PE COFF header is truncated",
    });
  const record = new BinaryReader(bytes, true, "pe");
  return ok({
    machine: record.u16(0),
    sectionCount: record.u16(2),
    symbolTableOffset: record.u32(8),
    symbolCount: record.u32(12),
    optionalHeaderSize: record.u16(16),
    characteristics: record.u16(18),
  });
};
