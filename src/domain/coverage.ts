import { z } from "zod";

/**
 * How much of an examined universe a producer covered. `complete` is a claim
 * the producer establishes from what it examined; `partial` records a known
 * gap; `unknown` means the producer could not tell. Absence of a report is
 * `unknown`, never `complete`.
 */
export const coverageStatusSchema = z.enum(["complete", "partial", "unknown"]);
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;

/**
 * Coverage of a producer that always decides it from what it examined, so it
 * never reports `unknown`.
 */
export const knownCoverageStatusSchema = coverageStatusSchema.exclude([
  "unknown",
]);
export type KnownCoverageStatus = z.infer<typeof knownCoverageStatusSchema>;

/**
 * Coverage of a producer that either covered its whole universe or cannot
 * tell how much it covered; it never measures a known gap, so it never
 * reports `partial`.
 */
export const completeOrUnknownCoverageSchema = coverageStatusSchema.exclude([
  "partial",
]);

/**
 * Fold the coverage of the inputs a result depends on. Unknown wins: one input
 * that cannot tell makes the whole unknown, even beside a known gap. Otherwise
 * any partial input makes the whole partial. Only all-complete inputs are
 * complete.
 */
export const joinCoverageStatus = (
  parts: readonly [CoverageStatus, ...CoverageStatus[]],
): CoverageStatus =>
  parts.includes("unknown")
    ? "unknown"
    : parts.includes("partial")
      ? "partial"
      : "complete";
