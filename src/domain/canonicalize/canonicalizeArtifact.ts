import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const rangeSchema = z.strictObject({ offset: uint, bytes: uint });

/** Hard ceiling on the caller-selected stable read budget (512 MiB). */
export const MAX_CANONICALIZE_FILE_BYTES = 536870912;
/** Default stable read budget (64 MiB), matching the native readers. */
export const DEFAULT_CANONICALIZE_FILE_BYTES = 67108864;
/** Hard ceiling on retained exemplar facts per collection. */
export const MAX_CANONICALIZE_FACTS = 4096;
/** Default retained exemplar facts per collection before collapse. */
export const DEFAULT_CANONICALIZE_FACTS = 128;
/** Hard ceiling on the behavior-relevant structural depth the pass descends. */
export const MAX_CANONICALIZE_DEPTH = 1000;
/** Default behavior-relevant structural depth; deeper structure is collapsed. */
export const DEFAULT_CANONICALIZE_DEPTH = 32;
/** Bounded exemplar/sample length retained for a collapsed region, in code units. */
export const CANONICALIZE_SAMPLE_UNITS = 96;

/** Requested normalizer selection; `auto` recognizes the format from the bytes. */
export const CANONICALIZE_REQUESTED_FORMATS = [
  "auto",
  "wasm",
  "asar",
  "json",
] as const;
export type CanonicalizeRequestedFormat =
  (typeof CANONICALIZE_REQUESTED_FORMATS)[number];

/** Format a normalizer actually recognized and canonicalized. */
export const CANONICALIZE_DETECTED_FORMATS = [
  "wasm",
  "asar",
  "json",
  "unknown",
] as const;
export type CanonicalizeDetectedFormat =
  (typeof CANONICALIZE_DETECTED_FORMATS)[number];

/**
 * How a region or item was classified relative to program behavior.
 *
 * `behavior-relevant` is retained; `non-semantic-padding` and
 * `decoy-unreachable` are collapsed to an exemplar, a count and a digest so
 * nothing is silently lost; `unverified` records a region the pass could not
 * prove either way and never confabulates about.
 */
export const CANONICALIZE_FACT_CLASSES = [
  "behavior-relevant",
  "non-semantic-padding",
  "decoy-unreachable",
  "unverified",
] as const;
export type CanonicalizeFactClass = (typeof CANONICALIZE_FACT_CLASSES)[number];

/** One classified structural region or item, with lossless-by-reference identity. */
export const canonicalizeFactSchema = z.strictObject({
  /** Owning collection, such as `wasm-section` or `asar-entry`. */
  collection: z.string().min(1),
  /** Section kind, custom-section name, entry path or structural path; null when unnamed. */
  name: z.string().nullable(),
  classification: z.enum(CANONICALIZE_FACT_CLASSES),
  /** Size of the region in bytes, or 0 when the item has no byte extent. */
  bytes: uint,
  /** File-offset extent when known; null for items without a byte position. */
  location: rangeSchema.nullable(),
  /** SHA-256 of the exact collapsed/retained region bytes; null when not hashed. */
  sha256: digestSchema.nullable(),
  /** Bounded printable exemplar of the region; null when omitted. */
  sample: z.string().nullable(),
  /** Short producer note; null when none. */
  detail: z.string().nullable(),
});
export type CanonicalizeFact = z.infer<typeof canonicalizeFactSchema>;

/** A redundancy/padding collapse recorded as counts plus aggregate bytes. */
export const canonicalizeReductionSchema = z.strictObject({
  collection: z.string().min(1),
  examined: uint,
  retained: uint,
  collapsed: uint,
  collapsed_bytes: uint,
  basis: z.string().min(1),
});
export type CanonicalizeReduction = z.infer<typeof canonicalizeReductionSchema>;

/** Examined-versus-total coverage with explicit truncation, never inferred absence. */
export const canonicalizeCoverageSchema = z.strictObject({
  status: z.enum(["complete", "partial"]),
  examined: uint,
  total: uint.nullable(),
  truncated: z.boolean(),
});
export type CanonicalizeCoverage = z.infer<typeof canonicalizeCoverageSchema>;

/** Bounded, deterministic extraction of behavior-relevant facts from one artifact. */
export const canonicalizeArtifactInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a selected local artifact to canonicalize",
  ),
  format: z
    .enum(CANONICALIZE_REQUESTED_FORMATS)
    .default("auto")
    .describe(
      "Normalizer selection; auto recognizes WASM, Electron .asar or structured JSON from the bytes",
    ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_CANONICALIZE_FILE_BYTES)
    .default(DEFAULT_CANONICALIZE_FILE_BYTES)
    .describe(
      "Maximum stable artifact bytes to read (default 64 MiB); bounds the pass's own memory against inflated inputs",
    ),
  max_facts: z
    .number()
    .int()
    .min(1)
    .max(MAX_CANONICALIZE_FACTS)
    .default(DEFAULT_CANONICALIZE_FACTS)
    .describe(
      "Maximum exemplar facts retained per collection before the remainder is collapsed to counts and a digest",
    ),
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_CANONICALIZE_DEPTH)
    .default(DEFAULT_CANONICALIZE_DEPTH)
    .describe(
      "Maximum behavior-relevant structural depth to descend; deeper nesting is collapsed and marked truncated",
    ),
});
export type CanonicalizeArtifactInput = z.infer<
  typeof canonicalizeArtifactInputSchema
>;

/** Structured, bounded canonicalization facts for one selected artifact. */
export const canonicalizeArtifactSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: z.string().min(1),
      sha256: digestSchema,
      bytes: uint,
    }),
    requested_format: z.enum(CANONICALIZE_REQUESTED_FORMATS),
    detected_format: z.enum(CANONICALIZE_DETECTED_FORMATS),
    /** Normalizer id that produced the facts, or `none` when unrecognized. */
    normalizer: z.string().min(1),
    /** Behavior-relevant regions and items retained for analysis. */
    core: z.array(canonicalizeFactSchema),
    /** Non-semantic padding and unreachable decoys collapsed to exemplars. */
    collapsed: z.array(canonicalizeFactSchema),
    reductions: z.array(canonicalizeReductionSchema),
    coverage: canonicalizeCoverageSchema,
    limitations: z.array(z.string()),
  })
  .superRefine((value, context) => {
    const within = (fact: CanonicalizeFact, index: number, key: string) => {
      if (fact.location === null) return;
      if (fact.location.offset + fact.location.bytes > value.artifact.bytes)
        context.addIssue({
          code: "custom",
          path: [key, index, "location"],
          message: "Fact location range exceeds the selected artifact bytes.",
        });
    };
    value.core.forEach((fact, index) => within(fact, index, "core"));
    value.collapsed.forEach((fact, index) => within(fact, index, "collapsed"));
    if (
      value.coverage.total !== null &&
      value.coverage.examined > value.coverage.total
    )
      context.addIssue({
        code: "custom",
        path: ["coverage", "examined"],
        message: "Examined count exceeds the reported total.",
      });
  });
export type CanonicalizeArtifact = z.infer<typeof canonicalizeArtifactSchema>;
