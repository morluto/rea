import type { Stats } from "node:fs";

import { expect, it } from "vitest";

import {
  changeTimeMayStillDrift,
  settleChangeTimeBaseline,
  type ChangeTimeSettleSeams,
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

const seamsAt = (
  nowMs: number,
  sleeps: number[] = [],
): ChangeTimeSettleSeams & { readonly sleeps: readonly number[] } => ({
  platform: "win32",
  now: () => nowMs,
  sleep: async (delayMs) => {
    sleeps.push(delayMs);
  },
  sleeps,
});

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
    seamsAt(1_000 + DRIFT_MS + 1),
  );
  expect(settled.ctimeMs).toBe(1_000);
  expect(reads()).toBe(1);
});

it("re-reads until two consecutive ChangeTimes agree", async () => {
  // The write's ChangeTime advances twice before it comes to rest.
  const { read, reads } = scriptedRead([1_500, 1_600, 1_700, 1_700]);
  const seams = seamsAt(1_700);
  const settled = await settleChangeTimeBaseline(read, seams);
  expect(settled.ctimeMs).toBe(1_700);
  expect(reads()).toBe(4);
  expect(seams.sleeps.length).toBe(3);
});

it("returns the establishment value once the window closes", async () => {
  const { read } = scriptedRead([1_050, 1_100]);
  const settled = await settleChangeTimeBaseline(read, seamsAt(1_999));
  expect(settled.ctimeMs).toBe(1_100);
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
  let changeTime = 1_000;
  const read = async (): Promise<Stats> => {
    changeTime += 1;
    return statsAt(changeTime);
  };
  const seams = seamsAt(1_010);
  const settled = await settleChangeTimeBaseline(read, seams);
  expect(settled.ctimeMs).toBe(changeTime);
  // Bounded by SETTLE_MAX_POLLS, not unbounded polling.
  expect(seams.sleeps.length).toBe(40);
});
