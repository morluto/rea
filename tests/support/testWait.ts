import { TestRunner, vi } from "vitest";

import { remainingTestDeadline, TEST_DEADLINE_MS } from "./testDeadlines.js";

/** Options for {@link waitFor}; the test deadline policy owns the timeout. */
export interface WaitForOptions {
  readonly interval?: number;
}

/**
 * Deadline for a wait: as long as its test may run, less the reporting reserve,
 * matching the project's `expect.poll` policy. Outside a test, as in
 * `beforeAll`, it uses the unscaled source deadline, which no project's hook
 * deadline is shorter than. A wait that starts late may outlast the test,
 * which then fails with Vitest's own timeout.
 */
export const testWaitDeadline = (): number => {
  const testDeadlineMs =
    TestRunner.getCurrentTest()?.timeout ?? TEST_DEADLINE_MS.source;
  return remainingTestDeadline(testDeadlineMs, 0) ?? TEST_DEADLINE_MS.source;
};

/**
 * `vi.waitFor` bounded by {@link testWaitDeadline} rather than Vitest's
 * one-second default, so a slow host neither fails a correct test nor needs a
 * literal timeout. Assert elapsed time explicitly, or order the condition
 * before a release gate, when promptness is the behavior under test.
 */
export const waitFor = <T>(
  callback: () => T | Promise<T>,
  options: WaitForOptions = {},
): Promise<T> =>
  // oxlint-disable-next-line rea/project-wait-deadline -- the owning helper.
  vi.waitFor(callback, { ...options, timeout: testWaitDeadline() });
