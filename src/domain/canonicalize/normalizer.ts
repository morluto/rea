import { createHash } from "node:crypto";

import type {
  CanonicalizeArtifact,
  CanonicalizeDetectedFormat,
  CanonicalizeRequestedFormat,
} from "./canonicalizeArtifact.js";

/** Facts a normalizer produces; the service adds artifact identity and request. */
export type NormalizedArtifactFacts = Pick<
  CanonicalizeArtifact,
  | "detected_format"
  | "normalizer"
  | "core"
  | "collapsed"
  | "reductions"
  | "coverage"
  | "limitations"
>;

/** Self-protection bounds the pass applies regardless of the artifact's claims. */
export interface NormalizerBudget {
  /** Maximum exemplar facts retained per collection before collapse. */
  readonly maxFacts: number;
  /** Maximum behavior-relevant structural depth to descend. */
  readonly maxDepth: number;
  /** Bounded exemplar length retained per collapsed region, in code units. */
  readonly sampleUnits: number;
}

/**
 * One pluggable, deterministic, side-effect-free format normalizer.
 *
 * A normalizer never executes, imports or mutates the artifact. It parses
 * defensively, bounds its own work by the supplied budget, and represents
 * anything it cannot prove as `unverified` rather than confabulating.
 */
export interface ArtifactNormalizer {
  readonly id: string;
  readonly format: Exclude<CanonicalizeDetectedFormat, "unknown">;
  /** Cheap structural recognition from a bounded prefix of the bytes. */
  recognizes(bytes: Buffer): boolean;
  canonicalize(
    bytes: Buffer,
    budget: NormalizerBudget,
  ): NormalizedArtifactFacts;
}

/** A config-driven, ordered set of normalizers; new shields add entries here. */
export interface CanonicalizeProfile {
  readonly normalizers: readonly ArtifactNormalizer[];
}

/** Hex SHA-256 of a region, so collapsed padding stays lossless by reference. */
export const canonicalizeDigest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A bounded, printable, NUL-free exemplar of a region. Control and non-ASCII
 * bytes become `.` so an adversarial region cannot smuggle terminal control
 * sequences or look like an instruction once sampled.
 */
export const canonicalizeSample = (
  bytes: Buffer,
  sampleUnits: number,
): string => {
  const limit = Math.max(0, Math.min(sampleUnits, bytes.length));
  let out = "";
  for (let index = 0; index < limit; index += 1) {
    const byte = bytes[index]!;
    out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
  }
  return out;
};

/** Facts for an artifact no normalizer recognized; identity is still retained. */
export const unrecognizedArtifactFacts = (): NormalizedArtifactFacts => ({
  detected_format: "unknown",
  normalizer: "none",
  core: [],
  collapsed: [],
  reductions: [],
  coverage: { status: "partial", examined: 0, total: null, truncated: false },
  limitations: [
    "No canonicalizer recognized this artifact; byte identity is retained and its structure is unverified.",
  ],
});

/** Facts when an explicitly requested normalizer did not recognize the bytes. */
export const unrecognizedRequestedFacts = (
  requested: CanonicalizeRequestedFormat,
): NormalizedArtifactFacts => ({
  ...unrecognizedArtifactFacts(),
  limitations: [
    `The selected artifact was not recognized as ${requested}; byte identity is retained and its structure is unverified.`,
  ],
});
