import { BinaryReader } from "../domain/binaryContainer.js";
import { Buffer } from "node:buffer";

/** UEFI GUIDs are 16 raw bytes rendered as 8-4-4-4-12 hex digits. */
export const GUID_LENGTH = 16;

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
  const reader = new BinaryReader(buffer, true, "UEFI GUID");
  const data1 = reader.u32(offset);
  const data2 = reader.u16(offset + 4);
  const data3 = reader.u16(offset + 6);
  const tail = buffer.subarray(offset + 8, offset + GUID_LENGTH);
  const word = (value: number, digits: number): string =>
    value.toString(16).padStart(digits, "0");
  const node = Array.from(tail, (byte) => word(byte, 2)).join("");
  return [
    word(data1, 8),
    word(data2, 4),
    word(data3, 4),
    node.slice(0, 4),
    node.slice(4),
  ].join("-");
}

/** Case-insensitive canonical GUID comparison. */
export function guidEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * FFS2 container GUID (PI Specification, firmware file system 2).
 * Raw bytes: 78 E5 8C 8C 3D 8A 1C 4F 99 35 89 61 85 C3 2D D3.
 */
export const FFS2_FILE_SYSTEM_GUID = "8c8ce578-8a3d-4f1c-9935-896185c32dd3";

/**
 * FFS3 container GUID (PI Specification, firmware file system 3).
 * Raw bytes: 07 12 73 54 41 5C BD 4C B5 E5 CD 26 D8 07 70 B1.
 */
export const FFS3_FILE_SYSTEM_GUID = "54731207-5c41-4cbd-b5e5-cd26d80770b1";
