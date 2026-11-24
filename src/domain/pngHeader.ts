import { crc32 } from "node:zlib";
import { BinaryReader } from "./binaryContainer.js";
import { err, ok, type Result } from "./result.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IHDR_DATA_BYTES = 13;
const PNG_CHUNK_OVERHEAD = 12;

/** PNG signature recognition does not establish image validity. */
export const hasPngSignature = (bytes: Buffer): boolean =>
  bytes.subarray(0, 8).equals(PNG_SIGNATURE);

interface PngChunk {
  readonly type: string;
  readonly data: Buffer;
  readonly nextOffset: number;
}

/** Frame reader for one PNG datastream, including each chunk's type and data CRC. */
export const createPngChunkReader = (bytes: Buffer) => {
  const reader = new BinaryReader(bytes, false, "png");
  return (
    offset: number,
    maxDataBytes = 0x7fff_ffff,
  ): Result<PngChunk, string> => {
    const remaining = bytes.length - offset;
    if (remaining < PNG_CHUNK_OVERHEAD) return err("Truncated PNG chunk");
    const length = reader.u32(offset);
    if (length > maxDataBytes) return err("Invalid PNG chunk length");
    if (length > remaining - PNG_CHUNK_OVERHEAD)
      return err("Truncated PNG data");
    const typeAndData = reader.range(offset + 4, 4 + length, "PNG chunk");
    const checksumOffset = offset + 8 + length;
    if (crc32(typeAndData) !== reader.u32(checksumOffset))
      return err("Invalid PNG chunk checksum");
    const type = typeAndData.toString("latin1", 0, 4);
    if (!/^[A-Za-z]{4}$/u.test(type) || type[2] !== type[2]?.toUpperCase())
      return err("Invalid PNG chunk type");
    return ok({
      type,
      data: typeAndData.subarray(4),
      nextOffset: checksumOffset + 4,
    });
  };
};

export interface PngIhdrFacts {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlaceMethod: number;
}

/**
 * Admit the declared IHDR fields (PNG specification, §11.2.1).
 * Image data and codec support are checked by consumers that decode it.
 */
export const readPngIhdrFacts = (
  data: Buffer,
): Result<PngIhdrFacts, string> => {
  if (data.length !== IHDR_DATA_BYTES) return err("Invalid PNG header");
  const header = new BinaryReader(data, false, "png");
  const width = header.u32(0);
  const height = header.u32(4);
  if (
    width === 0 ||
    height === 0 ||
    width > 0x7fff_ffff ||
    height > 0x7fff_ffff
  )
    return err("Invalid PNG header");
  const bitDepth = header.u8(8);
  const colorType = header.u8(9);
  const interlaceMethod = header.u8(12);
  const validDepth =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    (colorType === 4 && [8, 16].includes(bitDepth)) ||
    (colorType === 6 && [8, 16].includes(bitDepth));
  if (
    !validDepth ||
    header.u8(10) !== 0 ||
    header.u8(11) !== 0 ||
    (interlaceMethod !== 0 && interlaceMethod !== 1)
  )
    return err("Invalid PNG header");
  return ok({ width, height, bitDepth, colorType, interlaceMethod });
};

/** Read screenshot dimensions from a byte-faithful PNG header, not a full image decode. */
export const readPngHeaderDimensions = (
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined => {
  if (!hasPngSignature(bytes)) return undefined;
  const chunk = createPngChunkReader(bytes)(8, IHDR_DATA_BYTES);
  if (!chunk.ok || chunk.value.type !== "IHDR") return undefined;
  const facts = readPngIhdrFacts(chunk.value.data);
  return facts.ok
    ? { width: facts.value.width, height: facts.value.height }
    : undefined;
};
