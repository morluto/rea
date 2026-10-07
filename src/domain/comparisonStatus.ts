import { z } from "zod";

/**
 * Canonical top-level comparison outcome shared by every comparison
 * pipeline. Pipeline-native detail enums (bundle classifications,
 * source-to-bundle split/merge kinds, scenario alignment states, function
 * truncation) keep their wire schemas; the mappers below project each of
 * them onto this triple without changing any pipeline result.
 */
export const comparisonStatusSchema = z.enum([
  "unchanged",
  "changed",
  "unknown",
]);

export type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;

/** Canonical comparison conclusion shared by every comparison pipeline. */
export const comparisonConclusionSchema = z.enum([
  "observed_change",
  "derived_relationship",
  "contradiction",
  "unresolved_branch",
]);

/** Project a bundle change classification onto the canonical triple. */
export const bundleClassificationToCanonical = (
  classification:
    | "added"
    | "removed"
    | "changed"
    | "unknown"
    | "history_advanced"
    | "history_diverged",
): ComparisonStatus => (classification === "unknown" ? "unknown" : "changed");

/** Project a source-to-bundle item status onto the canonical triple. */
export const sourceToBundleStatusToCanonical = (
  status:
    | "unchanged"
    | "modified"
    | "removed"
    | "split"
    | "merged"
    | "duplicated"
    | "unknown",
): ComparisonStatus =>
  status === "unchanged"
    ? "unchanged"
    : status === "unknown"
      ? "unknown"
      : "changed";

/**
 * Project a function dimension status onto the canonical triple. A
 * truncated dimension cannot support an unchanged/changed claim.
 */
export const functionStatusToCanonical = (
  status: "unchanged" | "changed" | "truncated" | "unknown",
): ComparisonStatus =>
  status === "unchanged"
    ? "unchanged"
    : status === "changed"
      ? "changed"
      : "unknown";

/** Project a browser-scenario artifact status onto the canonical triple. */
export const scenarioArtifactStatusToCanonical = (
  status: "changed" | "unknown",
): ComparisonStatus => status;
