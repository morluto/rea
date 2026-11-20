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

it("starts the finalize budget when finalization begins, after work expired", () => {
  const deadline = Deadline.after(100, { finalizeMs: 500 });
  vi.advanceTimersByTime(300);
  expect(deadline.expired()).toBe(true);

  const finalize = deadline.beginFinalize();
  expect(finalize.remainingMs()).toBe(500);
  vi.advanceTimersByTime(499);
  expect(finalize.expired()).toBe(false);
  vi.advanceTimersByTime(1);
  expect(finalize.expired()).toBe(true);
  expect(finalize.beginFinalize().remainingMs()).toBe(0);
});

it("shares one finalize window across repeated beginFinalize calls", () => {
  const deadline = Deadline.after(100, { finalizeMs: 500 });
  const first = deadline.beginFinalize();
  vi.advanceTimersByTime(300);
  const second = deadline.beginFinalize();
  expect(second).toBe(first);
  expect(second.remainingMs()).toBe(200);
});

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
