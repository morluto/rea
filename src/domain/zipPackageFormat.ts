/** ZIP-backed application package families that share the hardened archive reader. */
export type ZipPackageFormat = "zip" | "ipa" | "apk" | "msix" | "appx";

/**
 * Classify a ZIP-backed package by its complete lower-cased path suffix.
 *
 * This is deliberately extension-only. Callers must separately verify ZIP
 * magic before trusting the classification for a root input.
 */
export const zipPackageFormatForPath = (
  path: string,
): ZipPackageFormat | undefined => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".ipa")) return "ipa";
  if (lower.endsWith(".apk") || lower.endsWith(".aab")) return "apk";
  if (lower.endsWith(".msix") || lower.endsWith(".msixbundle")) return "msix";
  if (lower.endsWith(".appx") || lower.endsWith(".appxbundle")) return "appx";
  return undefined;
};
