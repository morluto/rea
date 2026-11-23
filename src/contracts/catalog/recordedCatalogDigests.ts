import type { McpOutputSchemaProfile } from "../mcpSchemaPresentation.js";

/** SHA-256 digests of one catalog profile, as `createCatalogIdentity` reports them. */
export type CatalogDigests = {
  readonly tools_sha256: string;
  readonly prompts_sha256: string;
  readonly combined_sha256: string;
};

export type CatalogDigestProfiles = Readonly<
  Record<McpOutputSchemaProfile, CatalogDigests>
>;

export type CatalogCounts = {
  readonly cli_commands: number;
  readonly mcp_tools: number;
  readonly mcp_prompts: number;
};

export type CatalogIdentitySnapshot = {
  readonly counts: CatalogCounts;
  readonly digests: CatalogDigests;
};

/**
 * Digests of the two built-in output schema profiles over the compact input
 * presentation, recorded from the compiled contracts by
 * `scripts/record-catalog-digests.mjs` after compilation. Source runs leave
 * this undefined and compute them on first use.
 */
export const RECORDED_CATALOG_DIGEST_PROFILES:
  | CatalogDigestProfiles
  | undefined = undefined;

/**
 * Default catalog counts and digests recorded from the compiled contracts by
 * `scripts/record-catalog-digests.mjs` so read-only CLI diagnostics do not load
 * the complete contract registry. Source runs leave this undefined.
 */
export const RECORDED_DEFAULT_CATALOG_IDENTITY:
  | CatalogIdentitySnapshot
  | undefined = undefined;
