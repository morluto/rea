import { err, ok, type Result } from "./result.js";

export interface ElfFixedHeader {
  readonly elfClass: 32 | 64;
  readonly byteOrder: "little" | "big";
  readonly headerSize: number;
}

/**
 * Validate the common, fixed ELF header commitments.
 *
 * `bytes` may be a bounded prefix. `totalBytes` is the containing file size,
 * so the declared header extent is checked against the file without requiring
 * the whole declared extent to be present in this prefix.
 */
export const readElfFixedHeader = (
  bytes: Buffer,
  totalBytes = bytes.length,
): Result<ElfFixedHeader, string> => {
  if (bytes.length >= 4 && bytes.toString("hex", 0, 4) !== "7f454c46")
    return err("not an ELF image");
  if (bytes.length < 16) return err("ELF identification is truncated");
  const classByte = bytes[4];
  if (classByte !== 1 && classByte !== 2) return err("unsupported ELF class");
  const dataByte = bytes[5];
  if (dataByte !== 1 && dataByte !== 2)
    return err("unsupported ELF endianness");
  if (bytes[6] !== 1) return err("unsupported ELF identification version");

  const elfClass = classByte === 1 ? 32 : 64;
  const minimumSize = elfClass === 32 ? 52 : 64;
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < bytes.length ||
    totalBytes < minimumSize ||
    bytes.length < minimumSize
  )
    return err(
      `truncated ELF header: an ELF${elfClass} header needs ${minimumSize} bytes; the file has ${totalBytes}`,
    );
  const littleEndian = dataByte === 1;
  const readU16 = (offset: number): number =>
    littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const readU32 = (offset: number): number =>
    littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (readU32(20) !== 1) return err("unsupported ELF header version");
  const headerSize = readU16(elfClass === 32 ? 40 : 52);
  if (headerSize < minimumSize || headerSize > totalBytes)
    return err("invalid ELF header size");
  return ok({
    elfClass,
    byteOrder: littleEndian ? "little" : "big",
    headerSize,
  });
};
