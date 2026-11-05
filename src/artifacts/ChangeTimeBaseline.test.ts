import type { Stats } from "node:fs";

import { expect, it } from "vitest";

import {
  changeTimeMayStillDrift,
  settleChangeTimeBaseline,
} from "../filesystem/ChangeTimeBaseline.js";

const DRIFT_MS = 2_000;

const statsAt = (changeTimeMs: number): Stats =>
  ({ isFile: () => true, ctimeMs: changeTimeMs }) as Stats;

/** A read seam whose ChangeTime follows a scripted timeline. */
const scriptedRead = (changeTimes: readonly number[]) => {
  let index = 0;
  const read = async (): Promise<Stats> => {
    const value = changeTimes[Math.min(index, changeTimes.length - 1)]!;
    index += 1;
    return statsAt(value);
  };
  return { read, reads: () => index };
};

/**
 * A clock that advances only when the helper sleeps, the way a real wait does.
 * A frozen clock would let a test pass without the drift-window check ever
 * running, which is how the previous version of this file hid a real defect.
 */
const advancingSeams = (startMs: number, pollMs: number) => {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    platform: "win32" as const,
    now: () => now,
    sleep: async (delayMs: number) => {
      sleeps.push(delayMs);
      now += pollMs;
    },
    sleeps,
  };
};

it("treats a non-Windows host as already settled", async () => {
  const { read, reads } = scriptedRead([1_000]);
  const settled = await settleChangeTimeBaseline(read, {
    platform: "darwin",
    now: () => 1_001,
  });
  expect(settled.ctimeMs).toBe(1_000);
  expect(reads()).toBe(1);
});

it("does not re-enter the drift window for an established file", async () => {
  const { read, reads } = scriptedRead([1_000]);
  const settled = await settleChangeTimeBaseline(
    read,
    advancingSeams(1_000 + DRIFT_MS + 1, 100),
  );
  expect(settled.ctimeMs).toBe(1_000);
  expect(reads()).toBe(1);
});

it("keeps observing past a match that precedes a delayed Windows update", async () => {
  // Three reads agree at 1_500 because the delayed update has not landed yet.
  // Settling on a matching pair would return 1_500 and misreport the later 1_700.
  const { read, reads } = scriptedRead([1_500, 1_500, 1_500, 1_700, 1_700]);
  const settled = await settleChangeTimeBaseline(
    read,
    advancingSeams(1_500, 25),
  );
  expect(settled.ctimeMs).toBe(1_700);
  expect(reads()).toBeGreaterThan(2);
});

it("exits on the window closing rather than on a repeated value", async () => {
  const { read, reads } = scriptedRead([1_500, 1_500, 1_500]);
  const seams = advancingSeams(1_500, 1_000);
  const settled = await settleChangeTimeBaseline(read, seams);
  expect(settled.ctimeMs).toBe(1_500);
  // Both observations already agree after the first poll. Settling on that
  // match would stop there; this stops only once the clock leaves the window.
  expect(reads()).toBe(3);
  expect(seams.sleeps.length).toBe(2);
});

it("settles an unreadable ChangeTime rather than trusting it", () => {
  expect(
    changeTimeMayStillDrift(statsAt(Number.NaN), { platform: "win32" }),
  ).toBe(true);
  expect(
    changeTimeMayStillDrift(statsAt(Number.NaN), { platform: "linux" }),
  ).toBe(false);
});

it("gives up settling instead of stalling admission forever", async () => {
  const { read, reads } = scriptedRead([1_000]);
  const sleeps: number[] = [];
  const settled = await settleChangeTimeBaseline(read, {
    platform: "win32",
    // A clock that never advances leaves the window permanently open.
    now: () => 1_000,
    sleep: async (delayMs: number) => {
      sleeps.push(delayMs);
    },
  });
  expect(settled.ctimeMs).toBe(1_000);
  expect(sleeps.length).toBe(40);
  expect(reads()).toBeLessThanOrEqual(41);
});

it("uses the configured drift window, poll, and poll budget", async () => {
  const established = scriptedRead([1_000]);
  const settled = await settleChangeTimeBaseline(established.read, {
    platform: "win32",
    now: () => 1_500,
    environment: { REA_WINDOWS_CHANGE_TIME_DRIFT_MS: "100" },
  });
  expect(settled.ctimeMs).toBe(1_000);
  expect(established.reads()).toBe(1);

  const drifting = scriptedRead([1_000]);
  const sleeps: number[] = [];
  await settleChangeTimeBaseline(drifting.read, {
    platform: "win32",
    now: () => 1_000,
    sleep: async (delayMs: number) => {
      sleeps.push(delayMs);
    },
    environment: {
      REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS: "7",
      REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS: "2",
    },
  });
  expect(sleeps).toEqual([7, 7]);
  expect(drifting.reads()).toBe(3);
});

it("refuses an invalid drift setting instead of using the default", async () => {
  const { read, reads } = scriptedRead([1_000]);
  await expect(
    settleChangeTimeBaseline(read, {
      platform: "win32",
      environment: { REA_WINDOWS_CHANGE_TIME_DRIFT_MS: "1e3" },
    }),
  ).rejects.toMatchObject({
    _tag: "ConfigurationError",
    settings: [{ setting: "REA_WINDOWS_CHANGE_TIME_DRIFT_MS" }],
  });
  expect(reads()).toBe(0);
});

it("reads the settle limits from the selected runtime environment", async () => {
  // The owning runtime selects its own environment; ambient values can hold a
  // different drift window, or an invalid one that fails a valid runtime
  // (greptile review on rea#8979).
  const observeWith = async (environment: Record<string, string>) => {
    const { read, reads } = scriptedRead([1_000]);
    await settleChangeTimeBaseline(read, {
      platform: "win32",
      now: () => 1_001,
      environment,
      sleep: async () => {},
    });
    return reads();
  };

  // A 50 s selected window keeps a 1 s-old ChangeTime drifting; the ambient
  // 2 s default would call it settled after a single read.
  expect(
    await observeWith({ REA_WINDOWS_CHANGE_TIME_DRIFT_MS: "50000" }),
  ).toBeGreaterThan(1);
});

it("refuses an invalid value from the selected environment", async () => {
  // The ambient environment must not decide whether a valid runtime starts.
  const { read } = scriptedRead([1_000]);
  await expect(
    settleChangeTimeBaseline(read, {
      platform: "win32",
      now: () => 1_001,
      environment: { REA_WINDOWS_CHANGE_TIME_DRIFT_MS: "nonsense" },
    }),
  ).rejects.toThrow(/REA_WINDOWS_CHANGE_TIME_DRIFT_MS/);
});

it("stops settling as soon as the owning operation is cancelled", async () => {
  // A cancelled scope must not sit out the whole drift window; the previous
  // fixed budget bounded that at about one second (greptile review on rea#8979).
  const controller = new AbortController();
  const { read, reads } = scriptedRead([1_000, 1_000, 1_000]);
  const seams = advancingSeams(1_001, 25);
  await expect(
    settleChangeTimeBaseline(read, {
      ...seams,
      sleep: async (delayMs: number) => {
        await seams.sleep(delayMs);
        controller.abort(new Error("scope closed"));
      },
      signal: controller.signal,
    }),
  ).rejects.toThrow("scope closed");
  // One observation, one sleep: it never re-read after the abort.
  expect(reads()).toBe(1);
});

it("throws the caller's typed cancellation rather than the raw reason", async () => {
  // Callers recognise cancellation through their own error class; a raw
  // signal reason reads as a read failure to each of them
  // (greptile review on rea#8979).
  class Cancelled extends Error {}
  const controller = new AbortController();
  const { read } = scriptedRead([1_000]);
  const seams = advancingSeams(1_001, 25);
  await expect(
    settleChangeTimeBaseline(read, {
      ...seams,
      sleep: async (delayMs: number) => {
        await seams.sleep(delayMs);
        controller.abort(new Error("raw reason"));
      },
      signal: controller.signal,
      cancellationError: (reason) => new Cancelled(String(reason)),
    }),
  ).rejects.toBeInstanceOf(Cancelled);
});
