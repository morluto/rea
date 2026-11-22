import { TestRunner } from "vitest";

import { remainingTestDeadline } from "./testDeadlines.js";

/**
 * Deadline left for work started by the running test, or undefined outside a
 * test. Uses the real clock, so tests that fake `Date` keep a real deadline.
 */
export const runningTestDeadline = (): number | undefined => {
  const test = TestRunner.getCurrentTest();
  const started = test?.result?.startTime;
  if (test === undefined || started === undefined) return undefined;
  const now = performance.timeOrigin + performance.now();
  return remainingTestDeadline(test.timeout, now - started);
};
