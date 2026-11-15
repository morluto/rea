/**
 * Hang-detection deadlines that the Vitest project policy applies. Tests do not
 * restate them; see docs/development/testing.md#developer-commands.
 */
export const TEST_DEADLINE_MS = { source: 30_000, built: 120_000 } as const;

/** Deadline for a bounded workload tagged `long-running`. */
export const LONG_RUNNING_DEADLINE_MS = 300_000;

/** Coverage instrumentation slows every lane, so it scales every deadline. */
export const COVERAGE_DEADLINE_SCALE = 2;

/** Hosted CI runs a worker per core, so it also scales every deadline. */
export const HOSTED_RUNNER_DEADLINE_SCALE = 2;

/** Least time kept back from a test deadline to stop work and report it. */
const MIN_REPORT_RESERVE_MS = 5_000;

/** Least deadline handed to work that starts late in a test. */
const MIN_REMAINING_DEADLINE_MS = 1_000;

/**
 * Deadline for a wait or child started `elapsedMs` into a test: what remains,
 * less a reserve for stopping the work and reporting why. Hung work then fails
 * with its own diagnostics instead of an opaque test timeout, without a fixed
 * value that assumes a host's speed. Undefined when the test has no deadline.
 */
export const remainingTestDeadline = (
  testDeadlineMs: number,
  elapsedMs: number,
): number | undefined => {
  if (!(testDeadlineMs > 0)) return undefined;
  const reserve = Math.max(MIN_REPORT_RESERVE_MS, testDeadlineMs / 10);
  return Math.max(
    MIN_REMAINING_DEADLINE_MS,
    Math.floor(testDeadlineMs - elapsedMs - reserve),
  );
};
