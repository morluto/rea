import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import type { BinaryTarget } from "./binaryTargetTypes.js";
import { digestSchema } from "./digests.js";
import { rawBinaryEntryPointSchema } from "./rawBinary.js";

const flashOffsetSchema = z.number().int().min(0).max(0xffff_ffff).nullable();

/** Persisted facts inside a file's bytes that select what was analysed. */
export const fileTargetSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("entry-point"),
    entry_point: rawBinaryEntryPointSchema,
  }),
  z.strictObject({
    kind: z.literal("esp-flash"),
    flash_offset: flashOffsetSchema,
    partition_table_offset: flashOffsetSchema,
  }),
]);

/**
 * Facts inside a file's bytes that select what was analysed. Two observations
 * of the same bytes with different selections are different targets.
 */
export type FileTargetSelection = z.infer<typeof fileTargetSelectionSchema>;

/**
 * A hashed local file, path-free. Format and architecture are validated by
 * the persistence format that embeds the identity (for Evidence, the
 * format-owned subject declaration).
 */
export const fileTargetIdentitySchema = z.strictObject({
  kind: z.literal("file"),
  sha256: digestSchema,
  format: z.string().min(1),
  architecture: z.string().min(1).nullable(),
  selection: fileTargetSelectionSchema.nullable(),
});

/** A hashed local file, path-free. */
export interface FileTargetIdentity {
  readonly kind: "file";
  readonly sha256: string;
  readonly format: string;
  readonly architecture: string | null;
  readonly selection: FileTargetSelection | null;
}

/**
 * Why an observation names no target: it derives from linked Evidence that
 * already commits to its sources, the producer did not observe the target's
 * identity, or the target is not a kind REA can identify.
 */
export const unknownTargetReasonSchema = z.enum([
  "derived-from-linked-evidence",
  "not-observed",
  "unsupported-subject",
]);

/** A target whose identity is unknown, with the reason it is unknown. */
export const unknownTargetIdentitySchema = z.strictObject({
  kind: z.literal("unknown"),
  reason: unknownTargetReasonSchema,
});

/** A target whose identity is unknown, with the reason it is unknown. */
export interface UnknownTargetIdentity {
  readonly kind: "unknown";
  readonly reason: z.infer<typeof unknownTargetReasonSchema>;
}

/** The explicit identity of a target REA did not identify. */
export const unknownTarget = (
  reason: UnknownTargetIdentity["reason"],
): UnknownTargetIdentity => ({ kind: "unknown", reason });

/**
 * What an observation or cache entry is about. Tagged by `kind`; see
 * docs/adr/evidence/target-identity.md for the kinds later slices add.
 */
export type TargetIdentity = FileTargetIdentity | UnknownTargetIdentity;

/** The selection an open binary target makes inside its bytes, if any. */
export const binaryTargetSelection = (
  target: BinaryTarget,
): FileTargetSelection | null =>
  target.format === "raw-binary" || target.format === "gamecube-dol"
    ? { kind: "entry-point", entry_point: target.entryPoint }
    : target.format === "esp-flash-image"
      ? {
          kind: "esp-flash",
          flash_offset: target.espFlash.flashOffset,
          partition_table_offset: target.espFlash.partitionTableOffset,
        }
      : null;

/** The one projection of an open binary target into its target identity. */
export const binaryTargetIdentity = (
  target: BinaryTarget,
): FileTargetIdentity => ({
  kind: "file",
  sha256: target.sha256,
  format: target.format,
  architecture: target.architecture ?? null,
  selection: binaryTargetSelection(target),
});

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
