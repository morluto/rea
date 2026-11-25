/** Pixel arithmetic for admitted layouts. Callers retain validation, coverage,
 * resource budgets, color-policy interpretation and cancellation ownership.
 */
export function rasterThumbnailDimensions(
  width: number,
  height: number,
  maxSide?: number,
) {
  const scale =
    maxSide === undefined ? 1 : Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
export const rasterSampleCoordinate = (
  coordinate: number,
  sourceExtent: number,
  outputExtent: number,
): number => Math.floor((coordinate * sourceExtent) / outputExtent);

export function packedRasterIndex(
  byte: number,
  sourceX: number,
  bits: number,
  bitOrder: "msb-first" | "lsb-first",
): number {
  const bit = (sourceX * bits) % 8;
  const shift = bitOrder === "msb-first" ? 8 - bits - bit : bit;
  return (byte >>> shift) & ((1 << bits) - 1);
}
export const diagnosticRasterGray = (index: number, bits: number): number =>
  Math.round((index * 255) / ((1 << bits) - 1));
