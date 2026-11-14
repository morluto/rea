// @module-tag long-running
import { expect, inject, it } from "vitest";
import { LONG_RUNNING_DEADLINE_MS } from "../../support/testDeadlines.js";

it("applies the long-running deadline to every test of a tagged module", ({
  task,
}) => {
  expect(task.timeout).toBe(
    LONG_RUNNING_DEADLINE_MS * inject("testDeadlineScale"),
  );
});
