import type { JsonValue } from "../../domain/jsonValue.js";

/**
 * Build the import map installed for REA's trusted resolver stub.
 *
 * Chromium applies import-map `integrity` to the module script URL. The
 * resolver fulfills that URL with REA's replacement bytes, so integrity that
 * covers the selected importer must not be installed. Dependency integrity and
 * the caller-selected map identity remain unchanged in Evidence.
 */
export const importMapForTrustedResolver = (
  map: { readonly [key: string]: JsonValue },
  importerUrl: string,
  baseUrl: string,
): { readonly [key: string]: JsonValue } => {
  const integrity = map.integrity;
  if (
    integrity === null ||
    typeof integrity !== "object" ||
    Array.isArray(integrity)
  )
    return map;
  const importer = new URL(importerUrl, baseUrl);
  const nextIntegrity: { [key: string]: JsonValue } = Object.create(null);
  let removed = false;
  for (const [key, value] of Object.entries(integrity)) {
    if (integrityKeyMatchesImporter(key, baseUrl, importer)) {
      removed = true;
      continue;
    }
    nextIntegrity[key] = value;
  }
  if (!removed) return map;
  if (Object.keys(nextIntegrity).length === 0) {
    const { integrity: _omit, ...rest } = map;
    return rest;
  }
  return { ...map, integrity: nextIntegrity };
};

const integrityKeyMatchesImporter = (
  key: string,
  baseUrl: string,
  importer: URL,
): boolean => {
  try {
    const resolved = new URL(key, baseUrl);
    // Compare module URLs without search or fragment.
    return (
      resolved.origin === importer.origin &&
      resolved.pathname === importer.pathname
    );
  } catch {
    return false;
  }
};
