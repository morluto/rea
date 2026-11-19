import { crc32 } from "node:zlib";
import { err, ok, type Result } from "./result.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IHDR_TYPE = Buffer.from("IHDR");

/** PNG signature recognition does not establish image validity. */
export const hasPngSignature = (bytes: Buffer): boolean =>
  bytes.subarray(0, 8).equals(PNG_SIGNATURE);

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
  if (data.length !== 13) return err("Invalid PNG header");
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  if (
    width === 0 ||
    height === 0 ||
    width > 0x7fff_ffff ||
    height > 0x7fff_ffff
  )
    return err("Invalid PNG header");
  const bitDepth = data[8]!;
  const colorType = data[9]!;
  const interlaceMethod = data[12]!;
  const validDepth =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    (colorType === 4 && [8, 16].includes(bitDepth)) ||
    (colorType === 6 && [8, 16].includes(bitDepth));
  if (
    !validDepth ||
    data[10] !== 0 ||
    data[11] !== 0 ||
    (interlaceMethod !== 0 && interlaceMethod !== 1)
  )
    return err("Invalid PNG header");
  return ok({ width, height, bitDepth, colorType, interlaceMethod });
};

/** Read screenshot dimensions from a byte-faithful PNG header, not a full image decode. */
export const readPngHeaderDimensions = (
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined => {
  if (
    bytes.byteLength < 33 ||
    !hasPngSignature(bytes) ||
    bytes.readUInt32BE(8) !== 13 ||
    !bytes.subarray(12, 16).equals(IHDR_TYPE) ||
    crc32(bytes.subarray(12, 29)) !== bytes.readUInt32BE(29)
  )
    return undefined;
  const facts = readPngIhdrFacts(bytes.subarray(16, 29));
  return facts.ok
    ? { width: facts.value.width, height: facts.value.height }
    : undefined;
};
