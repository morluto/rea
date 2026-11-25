import { BinaryReader } from "../domain/binaryContainer.js";
import { Buffer } from "node:buffer";

/** UEFI GUIDs are 16 raw bytes rendered as 8-4-4-4-12 hex digits. */
export const GUID_LENGTH = 16;

const guidReaders = new WeakMap<Buffer, BinaryReader>();

function guidReader(buffer: Buffer): BinaryReader {
  let reader = guidReaders.get(buffer);
  if (reader === undefined) {
    reader = new BinaryReader(buffer, true, "UEFI GUID");
    guidReaders.set(buffer, reader);
  }
  return reader;
}

/**
 * Format a raw GUID with UEFI mixed-endian decoding: the first data word and
 * the two following words read little-endian, the remaining eight bytes keep
 * their written order. Returns null outside mapped bounds; null is an
 * observation, never a guessed identifier.
 */
export function formatGuidLittleEndian(
  buffer: Buffer,
  offset: number,
): string | null {
  if (offset < 0 || offset + GUID_LENGTH > buffer.length) {
    return null;
  }
  const reader = guidReader(buffer);
  const data1 = reader.u32(offset).toString(16).padStart(8, "0");
  const data2 = reader
    .u16(offset + 4)
    .toString(16)
    .padStart(4, "0");
  const data3 = reader
    .u16(offset + 6)
    .toString(16)
    .padStart(4, "0");
  const clockSeq = buffer.toString("hex", offset + 8, offset + 10);
  const node = buffer.toString("hex", offset + 10, offset + GUID_LENGTH);
  return `${data1}-${data2}-${data3}-${clockSeq}-${node}`;
}

/**
 * FFS2 container GUID (PI Specification, firmware file system 2).
 * Raw bytes: 78 E5 8C 8C 3D 8A 1C 4F 99 35 89 61 85 C3 2D D3.
 */
export const FFS2_FILE_SYSTEM_GUID = "8c8ce578-8a3d-4f1c-9935-896185c32dd3";

/**
 * FFS3 container GUID (PI Specification, firmware file system 3).
 * Raw bytes: 7A C0 73 54 CB 3D CA 4D BD 6F 1E 96 89 E7 34 9A.
 */
export const FFS3_FILE_SYSTEM_GUID = "5473c07a-3dcb-4dca-bd6f-1e9689e7349a";
