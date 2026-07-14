import { describe, expect, it } from "vitest";

import { createProgressReporter } from "../src/application/ProgressReporter.js";

describe("progress reporter", () => {
  it("preserves monotonic order, rate bounds intermediate updates, and always emits terminal state", async () => {
    let now = 0;
    const observed: unknown[] = [];
    const reporter = createProgressReporter(
      (update) => {
        observed.push(update);
        return Promise.resolve();
      },
      { minimumIntervalMs: 100, now: () => now },
    );
    await reporter.report({
      phase: "scan",
      completed: 0,
      total: 3,
      message: "start",
    });
    now = 10;
    await reporter.report({
      phase: "scan",
      completed: 1,
      total: 3,
      message: "one",
    });
    now = 20;
    await reporter.report({
      phase: "scan",
      completed: 3,
      total: 3,
      message: "done",
      terminal: true,
    });

    expect(observed).toEqual([
      expect.objectContaining({ sequence: 1, completed: 0 }),
      expect.objectContaining({ sequence: 2, completed: 3, terminal: true }),
    ]);
    await expect(
      reporter.report({
        phase: "scan",
        completed: 2,
        total: 3,
        message: "back",
      }),
    ).rejects.toThrow(/backwards/u);
  });
});
