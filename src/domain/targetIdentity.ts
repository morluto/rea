import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

/**
 * Facts inside a file's bytes that select what was analysed. Two observations
 * of the same bytes with different selections are different targets.
 */
export type FileTargetSelection =
  | { readonly kind: "entry-point"; readonly entry_point: string }
  | {
      readonly kind: "esp-flash";
      readonly flash_offset: number | null;
      readonly partition_table_offset: number | null;
    };

/** A hashed local file, path-free. */
export interface FileTargetIdentity {
  readonly kind: "file";
  readonly sha256: string;
  readonly format: string;
  readonly architecture: string | null;
  readonly selection: FileTargetSelection | null;
}

/**
 * What an observation or cache entry is about. Tagged by `kind`; see
 * docs/adr/evidence/target-identity.md for the kinds later slices add.
 */
export type TargetIdentity = FileTargetIdentity;

/** The only comparison of two target identities: an RFC 8785 canonical digest. */
export const targetIdentityKey = (identity: TargetIdentity): string => {
  const encoded = canonicalize(identity);
  if (encoded === undefined)
    throw new TypeError("RFC 8785 canonicalization rejected a target identity");
  return `target_${createHash("sha256").update(encoded).digest("hex")}`;
};

/** Whether two identities name the same target. */
export const sameTargetIdentity = (
  left: TargetIdentity,
  right: TargetIdentity,
): boolean => targetIdentityKey(left) === targetIdentityKey(right);
