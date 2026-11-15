import type { CatalogDigestProfiles } from "./catalogIdentity.js";

/**
 * Digests of the two built-in output schema profiles over the compact input
 * presentation, recorded from the compiled contracts by
 * `scripts/record-catalog-digests.mjs` after compilation. Source runs leave
 * this undefined and compute them on first use.
 */
export const RECORDED_CATALOG_DIGEST_PROFILES:
  | CatalogDigestProfiles
  | undefined = undefined;
