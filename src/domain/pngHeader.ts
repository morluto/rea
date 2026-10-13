const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IHDR_TYPE = Buffer.from("IHDR");

/** Read screenshot dimensions from a byte-faithful PNG header, not a full image decode. */
export const readPngHeaderDimensions = (
  bytes: Buffer,
): { readonly width: number; readonly height: number } | undefined => {
  if (
    bytes.byteLength < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    !bytes.subarray(12, 16).equals(IHDR_TYPE)
  )
    return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width === 0 ||
    height === 0 ||
    width > 0x7fff_ffff ||
    height > 0x7fff_ffff
    ? undefined
    : { width, height };
};
