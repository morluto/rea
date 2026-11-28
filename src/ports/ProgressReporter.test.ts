import { expect, it } from "vitest";

import { createProgressReporter } from "./ProgressReporter.js";

it("limits intermediate sends to 100 ms and always delivers terminal status", async () => {
  let now = 0;
  const sent: number[] = [];
  const reporter = createProgressReporter(
    async () => {
      sent.push(now);
    },
    { now: () => now },
  );
  for (const [completed, elapsed] of [0, 25, 50, 99, 100, 199, 200].entries()) {
    now = elapsed;
    await reporter.report({
      phase: "running",
      completed,
      total: null,
      message: "Observed capture status",
    });
  }
  expect(sent).toEqual([0, 100, 200]);
  now = 201;
  await reporter.report({
    phase: "cleanup",
    completed: 7,
    total: null,
    message: "Owned cleanup complete",
    terminal: true,
  });
  expect(sent).toEqual([0, 100, 200, 201]);
});

it("bounds each phase separately, so a heartbeat cannot suppress another phase", async () => {
  let now = 0;
  const sent: string[] = [];
  const reporter = createProgressReporter(
    async (update) => {
      sent.push(`${update.phase}@${String(now)}#${String(update.sequence)}`);
    },
    { now: () => now },
  );
  const report = (phase: string, at: number) => {
    now = at;
    return reporter.report({
      phase,
      completed: 0,
      total: null,
      message: phase,
    });
  };
  // A heartbeat every second, and a workflow update 1 ms after one of them.
  await report("hopper_request", 0);
  await report("hopper_request", 1000);
  await report("decompile_all", 1001);
  await report("decompile_all", 1050);
  await report("hopper_request", 1060);
  await report("hopper_request", 2000);
  expect(sent).toEqual([
    "hopper_request@0#1",
    "hopper_request@1000#2",
    "decompile_all@1001#3",
    "hopper_request@2000#4",
  ]);
});
