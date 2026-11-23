import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Deadline } from "./deadline.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

it.each([-3_600_000, 3_600_000])(
  "keeps the work budget when the wall clock jumps by %i ms",
  (jump) => {
    const deadline = Deadline.after(1_000);
    vi.advanceTimersByTime(250);
    vi.setSystemTime(Date.now() + jump);
    expect(deadline.remainingMs()).toBe(750);
    expect(deadline.expired()).toBe(false);
    vi.advanceTimersByTime(750);
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired()).toBe(true);
  },
);

it.each([50, 300])(
  "starts one shared finalize window %i ms after work starts",
  (elapsed) => {
    const work = Deadline.after(100, { finalizeMs: 500 });
    vi.advanceTimersByTime(elapsed);
    expect(work.expired()).toBe(elapsed >= 100);

    const finalizing = work.beginFinalize();
    expect(finalizing.remainingMs()).toBe(500);
    vi.advanceTimersByTime(499);
    expect(work.beginFinalize()).toBe(finalizing);
    expect(finalizing.remainingMs()).toBe(1);
    expect(finalizing.expired()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(finalizing.expired()).toBe(true);
    expect(finalizing.beginFinalize().remainingMs()).toBe(0);
  },
);

it("grants no finalize budget unless one is declared", () => {
  expect(Deadline.after(100).beginFinalize().expired()).toBe(true);
});

it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
  "rejects a budget outside the Node timer range (%d)",
  (milliseconds) => {
    expect(() => Deadline.after(milliseconds)).toThrow(RangeError);
    expect(() => Deadline.after(1, { finalizeMs: milliseconds })).toThrow(
      RangeError,
    );
  },
);
