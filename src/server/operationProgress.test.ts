import { expect, it, vi } from "vitest";

import { createOperationProgress } from "./operationProgress.js";

const cleanup = {
  phase: "cleanup",
  completed: 3,
  total: null,
  message: "disposition=timeout owned_process_group=cleaned",
  terminal: true,
} as const;

it("preserves the complete workflow's terminal observation on successful delivery", async () => {
  const report = vi.fn().mockResolvedValue(undefined);
  const progress = createOperationProgress({ report }, "capture", "workflow");
  await progress.start();
  await progress.report(cleanup);
  const response = { content: [] };
  expect(await progress.complete(response)).toBe(response);
  expect(report.mock.calls.at(-1)?.[0]).toEqual(cleanup);
  expect(report).toHaveBeenCalledTimes(2);
});

it("retains cleanup facts when delivery fails after the workflow's terminal observation", async () => {
  const report = vi.fn().mockResolvedValue(undefined);
  const progress = createOperationProgress({ report }, "capture", "workflow");
  await progress.report(cleanup);
  await progress.complete({ content: [], isError: true });
  expect(report.mock.calls.at(-1)?.[0]).toEqual({
    ...cleanup,
    phase: "capture",
    message: "failed; cleanup: disposition=timeout owned_process_group=cleaned",
  });
});

it("does not treat a child terminal observation as the complete operation's terminal", async () => {
  const report = vi.fn().mockResolvedValue(undefined);
  const progress = createOperationProgress({ report }, "parent");
  await progress.report(cleanup);
  await progress.complete({ content: [] });
  expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "parent",
    message: "completed",
    terminal: true,
  });
});

it("allows a workflow to continue after a child's terminal observation", async () => {
  const report = vi.fn().mockResolvedValue(undefined);
  const progress = createOperationProgress({ report }, "parent", "workflow");
  await progress.report(cleanup);
  await progress.report({
    phase: "reconcile",
    completed: 0,
    total: null,
    message: "examining",
  });
  await progress.complete({ content: [] });
  expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "parent",
    message: "completed",
    terminal: true,
  });
});

it.each([false, true])(
  "finishes a workflow with no producer terminal (isError=%s)",
  async (isError) => {
    const report = vi.fn().mockResolvedValue(undefined);
    const progress = createOperationProgress({ report }, "plan", "workflow");
    await progress.complete({ content: [], isError });
    expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: "plan",
      message: isError ? "failed" : "completed",
      terminal: true,
    });
  },
);
