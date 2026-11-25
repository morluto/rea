/** Android boot image magic values; the header parser lives with its reader. */
export const ANDROID_BOOT_MAGIC = "ANDROID!";
export const VENDOR_BOOT_MAGIC = "VNDRBOOT";
/** Standalone vbmeta image magic (AOSP `libavb` `AVB_MAGIC`). */
export const AVB_VBMETA_MAGIC = "AVB0";
const ANDROID_BOOT_MAGIC_BYTES = Buffer.from(ANDROID_BOOT_MAGIC);
const VENDOR_BOOT_MAGIC_BYTES = Buffer.from(VENDOR_BOOT_MAGIC);
const AVB_VBMETA_MAGIC_BYTES = Buffer.from(AVB_VBMETA_MAGIC);

/** True when the first eight bytes are ANDROID! or VNDRBOOT. */
export const hasAndroidBootImageMagic = (prefix: Buffer): boolean =>
  prefix.length >= 8 &&
  (prefix.subarray(0, 8).equals(ANDROID_BOOT_MAGIC_BYTES) ||
    prefix.subarray(0, 8).equals(VENDOR_BOOT_MAGIC_BYTES));

/** True when the first four bytes are the standalone vbmeta magic AVB0. */
export const hasAvbVbmetaImageMagic = (prefix: Buffer): boolean =>
  prefix.length >= 4 && prefix.subarray(0, 4).equals(AVB_VBMETA_MAGIC_BYTES);
