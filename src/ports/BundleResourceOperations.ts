import type { AnalysisOperation } from "./AnalysisProvider.js";

/**
 * The read-only app-resource operations a bundle resource session serves,
 * split by the provider that owns each format: native reads property lists,
 * and artifacts reads Interface Builder files, asset catalogs and keyed
 * archives. Sessions, discovery and the providers share this one policy.
 */
export const BUNDLE_NATIVE_RESOURCE_OPERATIONS = new Set<AnalysisOperation>([
  "inspect_plist",
]);

export const BUNDLE_ARTIFACT_RESOURCE_OPERATIONS = new Set<AnalysisOperation>([
  "decode_interface_builder",
  "inspect_asset_catalog",
  "inspect_keyed_archive",
]);

export const BUNDLE_RESOURCE_OPERATIONS = new Set<AnalysisOperation>([
  ...BUNDLE_NATIVE_RESOURCE_OPERATIONS,
  ...BUNDLE_ARTIFACT_RESOURCE_OPERATIONS,
]);

/** Share the dispatch owner's resource-session operation policy with discovery. */
export const isBundleResourceOperation = (name: string): boolean => {
  for (const operation of BUNDLE_RESOURCE_OPERATIONS)
    if (operation === name) return true;
  return false;
};
