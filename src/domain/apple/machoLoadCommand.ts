/** loader.h requires 8-byte command alignment for 64-bit images, 4 for 32-bit. */
export const validMachOLoadCommandSize = (
  size: number,
  remaining: number,
  wide: boolean,
): boolean => size >= 8 && size % (wide ? 8 : 4) === 0 && size <= remaining;
