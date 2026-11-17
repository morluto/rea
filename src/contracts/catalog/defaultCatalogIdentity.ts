import {
  RECORDED_DEFAULT_CATALOG_IDENTITY,
  type CatalogIdentitySnapshot,
} from "./recordedCatalogDigests.js";

/**
 * Resolve the package's default catalog counts and digests from the recorded
 * build fact when available, falling back to live contract evaluation in
 * uncompiled source runs.
 */
export const loadDefaultCatalogIdentity =
  async (): Promise<CatalogIdentitySnapshot> =>
    RECORDED_DEFAULT_CATALOG_IDENTITY ??
    (await import("./catalogIdentity.js")).DEFAULT_CATALOG_IDENTITY;
