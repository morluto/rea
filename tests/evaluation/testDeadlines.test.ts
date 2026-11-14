import { expect, inject, it } from "vitest";
import {
  COVERAGE_DEADLINE_SCALE,
  HOSTED_RUNNER_DEADLINE_SCALE,
  remainingTestDeadline,
  TEST_DEADLINE_MS,
} from "../support/testDeadlines.js";
import { waitFor } from "../support/testWait.js";

// Longer than Vitest's one-second wait default, so these probes fail if the
// project deadline policy stops owning wait deadlines.
const PAST_VITEST_WAIT_DEFAULT_MS = 1_200;

it("applies the source project deadline, scaled by coverage and hosted runners", ({
  task,
}) => {
  const scale = inject("testDeadlineScale");
  const coverage = [1, COVERAGE_DEADLINE_SCALE];
  const hosted = [1, HOSTED_RUNNER_DEADLINE_SCALE];
  expect(coverage.flatMap((c) => hosted.map((h) => c * h))).toContain(scale);
  expect(task.timeout).toBe(TEST_DEADLINE_MS.source * scale);
});

it("derives a wait or child deadline from the test deadline, keeping a reporting reserve", () => {
  expect(remainingTestDeadline(120_000, 0)).toBe(108_000);
  expect(remainingTestDeadline(30_000, 20_000)).toBe(5_000);
  // The reserve never drops below five seconds, nor the deadline below one.
  expect(remainingTestDeadline(8_000, 0)).toBe(3_000);
  expect(remainingTestDeadline(8_000, 7_500)).toBe(1_000);
  expect(remainingTestDeadline(0, 0)).toBeUndefined();
});

it("bounds expect.poll by the project deadline", async () => {
  const ready = performance.now() + PAST_VITEST_WAIT_DEFAULT_MS;
  await expect.poll(() => performance.now() >= ready).toBe(true);
});

it("bounds waitFor by its test's deadline", async () => {
  const ready = performance.now() + PAST_VITEST_WAIT_DEFAULT_MS;
  await waitFor(() => {
    if (performance.now() < ready) throw new Error("not ready yet");
  });
});
