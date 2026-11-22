import { describe, expect, inject, it } from "vitest";
import {
  LONG_RUNNING_DEADLINE_MS,
  TEST_DEADLINE_MS,
} from "../../support/testDeadlines.js";

// These probes read the deadline Vitest collected, so they fail if project
// inheritance or tag resolution stops applying the configured policy.
const scale = inject("testDeadlineScale");

it("applies the built project deadline to an untagged test", ({ task }) => {
  expect(task.timeout).toBe(TEST_DEADLINE_MS.built * scale);
});

it(
  "applies the long-running deadline to a tagged test",
  { tags: ["long-running"] },
  ({ task }) => {
    expect(task.timeout).toBe(LONG_RUNNING_DEADLINE_MS * scale);
  },
);

describe("a long-running suite", { tags: ["long-running"] }, () => {
  it("passes the long-running deadline to its tests", ({ task }) => {
    expect(task.timeout).toBe(LONG_RUNNING_DEADLINE_MS * scale);
  });
});
