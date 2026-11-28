import { BinaryReader } from "./binaryContainer.js";

/** The little-endian word at `offset`, when the prefix holds it. */
const leU32 = (prefix: Uint8Array, offset: number): number | undefined =>
  prefix.length < offset + 4
    ? undefined
    : new BinaryReader(
        Buffer.from(prefix.buffer, prefix.byteOffset, prefix.length),
        true,
        "gpu-asset",
      ).u32(offset);

/**
 * Leading signatures of GPU asset containers with public headers:
 *
 * - DDS: Microsoft "DDS file layout", magic `DDS ` then a 124-byte DDS_HEADER.
 * - GLB: glTF 2.0 specification §4.4 "Binary glTF Layout", magic `glTF`.
 * - KTX 1.1 and KTX 2.0: Khronos KTX specifications, 12-byte identifiers.
 */
export const DDS_MAGIC = Buffer.from("DDS ", "latin1");
export const GLB_MAGIC = Buffer.from("glTF", "latin1");
export const KTX1_IDENTIFIER = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export const KTX2_IDENTIFIER = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const startsWith = (prefix: Uint8Array, magic: Uint8Array): boolean =>
  prefix.length >= magic.length &&
  magic.every((byte, index) => prefix[index] === byte);

/** `DDS ` followed by a DDS_HEADER whose dwSize is 124. */
export const hasDdsHeader = (prefix: Uint8Array): boolean =>
  startsWith(prefix, DDS_MAGIC) && leU32(prefix, 4) === 124;

/** `glTF` followed by container version 2. */
export const hasGlbHeader = (prefix: Uint8Array): boolean =>
  startsWith(prefix, GLB_MAGIC) && leU32(prefix, 4) === 2;

export const hasKtx1Identifier = (prefix: Uint8Array): boolean =>
  startsWith(prefix, KTX1_IDENTIFIER);

export const hasKtx2Identifier = (prefix: Uint8Array): boolean =>
  startsWith(prefix, KTX2_IDENTIFIER);
