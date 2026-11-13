import { expect, inject, it } from "vitest";
import {
  COVERAGE_DEADLINE_SCALE,
  HOSTED_RUNNER_DEADLINE_SCALE,
  TEST_DEADLINE_MS,
} from "../support/testDeadlines.js";

it("applies the source project deadline, scaled by coverage and hosted runners", ({
  task,
}) => {
  const scale = inject("testDeadlineScale");
  const coverage = [1, COVERAGE_DEADLINE_SCALE];
  const hosted = [1, HOSTED_RUNNER_DEADLINE_SCALE];
  expect(coverage.flatMap((c) => hosted.map((h) => c * h))).toContain(scale);
  expect(task.timeout).toBe(TEST_DEADLINE_MS.source * scale);
});
