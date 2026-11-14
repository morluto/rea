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
