import { expect, it, vi } from "vitest";
import { CdpExecutionWindow } from "./CdpExecutionWindow.js";

it("settles an already lost transport without arming a timer that cannot resolve", async () => {
  const window = new CdpExecutionWindow({
    target: { frame_id: "selected-main" },
    operation: "observe_web_execution",
    options: {},
  });
  window.end("target_terminated");
  await expect(window.start(30_000)).resolves.toBe("target_terminated");
  expect(window.active).toBe(false);
});

it("ends the actual armed window at its selected duration and disposes its timer", async () => {
  vi.useFakeTimers();
  const window = new CdpExecutionWindow({
    target: { frame_id: "selected-main" },
    operation: "observe_web_execution",
    options: {},
  });
  try {
    const result = window.start(10);
    expect(window.active).toBe(true);
    vi.advanceTimersByTime(10);
    await expect(result).resolves.toBe("window_elapsed");
    expect(window.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    window.dispose();
    vi.useRealTimers();
  }
});

it("settles caller cancellation and removes its local timer", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const window = new CdpExecutionWindow({
    target: { frame_id: "selected-main" },
    operation: "observe_web_execution",
    options: { signal: controller.signal },
  });
  try {
    const assertion = expect(window.start(30_000)).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
    });
    controller.abort();
    await assertion;
    expect(window.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    window.dispose();
    vi.useRealTimers();
  }
});
