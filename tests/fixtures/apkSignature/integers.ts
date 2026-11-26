/** APK fixture fields retain the low bits of deliberately malformed numeric inputs. */
export const u16 = (value: number): number[] => [
  value & 0xff,
  (value >> 8) & 0xff,
];
export const u32 = (value: number): number[] => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >>> 24) & 0xff,
];
/** These fixtures encode sizes in the low word of a 64-bit field. */
export const u64 = (value: number): number[] => [...u32(value), ...u32(0)];
