/** ZIP-backed application package families that share the hardened archive reader. */
export type ZipPackageFormat =
  | "zip"
  | "ipa"
  | "apk"
  | "msix"
  | "appx"
  | "hap"
  | "hsp"
  | "app-pack";

/** Recognize local-header, empty-archive, or split-archive ZIP signatures, not archive validity. */
export const hasZipSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08));

/**
 * Classify a ZIP-backed package by its complete lower-cased path suffix.
 *
 * This is deliberately extension-only. Callers must separately verify ZIP
 * magic before trusting the classification for a root input. HarmonyOS `.har`
 * is intentionally absent: the suffix also names HTTP Archive JSON, so a
 * Harmony shared archive is only established from verified ZIP bytes. The
 * HarmonyOS App Pack suffix `.app` is also absent here: it applies only to
 * root inputs (see `classifyAndHashRoot`), because a nested ZIP entry ending
 * in `.app` inside another package, such as an IPA, is not an App Pack.
 */
export const zipPackageFormatForPath = (
  path: string,
): ZipPackageFormat | undefined => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".ipa")) return "ipa";
  // An Android App Bundle is a ZIP archive, not a standalone APK.
  if (lower.endsWith(".apk")) return "apk";
  if (lower.endsWith(".msix") || lower.endsWith(".msixbundle")) return "msix";
  if (lower.endsWith(".appx") || lower.endsWith(".appxbundle")) return "appx";
  if (lower.endsWith(".hap")) return "hap";
  if (lower.endsWith(".hsp")) return "hsp";
  return undefined;
};

/** Inventory cannot see bytes that are not central-directory entries. */
export const ZIP_NON_ENTRY_TAIL_LIMITATION =
  "ZIP inventory lists central-directory entries only. Bytes after the central directory, including an APK Signing Block or a ZIP comment, are not occurrences.";
