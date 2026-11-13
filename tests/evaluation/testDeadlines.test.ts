import { expect, inject, it } from "vitest";
import {
  COVERAGE_DEADLINE_SCALE,
  TEST_DEADLINE_MS,
} from "../support/testDeadlines.js";

it("applies the source project deadline, scaled only by coverage", ({
  task,
}) => {
  const scale = inject("testDeadlineScale");
  expect([1, COVERAGE_DEADLINE_SCALE]).toContain(scale);
  expect(task.timeout).toBe(TEST_DEADLINE_MS.source * scale);
});
