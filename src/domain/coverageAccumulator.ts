import { joinCoverageStatus, type CoverageStatus } from "./coverage.js";

/**
 * Monotonic coverage accumulator built on {@link joinCoverageStatus}.
 *
 * Producers record what they examined, omitted, or could not verify. Once any
 * omission, fallback, or unknown fact is recorded, the accumulator cannot
 * return `"complete"`. An accumulator with zero observations finalizes to
 * `"unknown"`, never `"complete"`.
 */
export class CoverageAccumulator {
  readonly #statuses: CoverageStatus[] = [];
  readonly #reasons: string[] = [];

  /** Record a verified complete facet or region. */
  recordComplete(): this {
    this.#statuses.push("complete");
    return this;
  }

  /** Record a known omission, truncation, or unexamined region. */
  recordOmission(reason: string): this {
    this.#statuses.push("partial");
    this.#reasons.push(reason);
    return this;
  }

  /** Record a condition whose completeness could not be established. */
  recordUnknown(reason: string): this {
    this.#statuses.push("unknown");
    this.#reasons.push(reason);
    return this;
  }

  /** Fold another coverage status into this accumulator. */
  merge(status: CoverageStatus, reason?: string): this {
    this.#statuses.push(status);
    if (reason !== undefined && status !== "complete") {
      this.#reasons.push(reason);
    }
    return this;
  }

  /** Fold all recorded observations into one coverage status and reason list. */
  finalize(): {
    readonly status: CoverageStatus;
    readonly reasons: readonly string[];
  } {
    if (this.#statuses.length === 0) {
      return { status: "unknown", reasons: [...this.#reasons] };
    }
    return {
      status: joinCoverageStatus(
        this.#statuses as [CoverageStatus, ...CoverageStatus[]],
      ),
      reasons: [...this.#reasons],
    };
  }

  /** Finalize to `"complete" | "partial"` for producers that never emit `"unknown"`. */
  finalizeKnown(): "complete" | "partial" {
    return this.finalize().status === "complete" ? "complete" : "partial";
  }

  /** Finalize to `"complete" | "unknown"` for producers that never emit `"partial"`. */
  finalizeCompleteOrUnknown(): "complete" | "unknown" {
    return this.finalize().status === "complete" ? "complete" : "unknown";
  }
}

/**
 * Convenience helper for single-condition `"complete" | "partial"` derivation
 * through {@link CoverageAccumulator}.
 */
export const knownCoverage = (
  isComplete: boolean,
  omissionReason = "incomplete observation",
): "complete" | "partial" => {
  const acc = new CoverageAccumulator().recordComplete();
  if (!isComplete) acc.recordOmission(omissionReason);
  return acc.finalizeKnown();
};
