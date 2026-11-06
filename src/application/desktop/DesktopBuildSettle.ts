import { setTimeout as delay } from "node:timers/promises";

import {
  appFileDigests,
  type SettleTiming,
} from "../../domain/desktop/appSettle.js";

/** The last data/get answer of a settled read, and whether the app's files had held for the window by then. */
export interface SettledRead {
  readonly parts: readonly unknown[];
  readonly settled: boolean;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Read an app's data/get every interval until each file's bytes have held
 * for the window, counted from the first read or the last change, or until
 * the bound, as the exported verifier does; `waiting` hears why it reads again.
 */
export const settledAppData = async (
  read: (signal: AbortSignal) => Promise<readonly unknown[]>,
  timing: SettleTiming,
  signal: AbortSignal,
  waiting: (message: string) => Promise<void>,
): Promise<SettledRead> => {
  const start = performance.now();
  let parts = await read(signal);
  let files = appFileDigests(parts);
  // Offsets from the first read's start: a read on time starts on a whole interval.
  let at = 0;
  let since = 0;
  const unsettled = () => at - since < timing.windowMs && at < timing.boundMs;
  while (unsettled()) {
    await delay(
      Math.max(0, at + timing.intervalMs - (performance.now() - start)),
      undefined,
      { signal },
    );
    at = Math.max(at + timing.intervalMs, performance.now() - start);
    parts = await read(signal);
    const latest = appFileDigests(parts);
    if (latest !== files) {
      since = at;
      files = latest;
    }
    if (unsettled())
      await waiting(
        `waiting for the app's files to hold for ${seconds(timing.windowMs)}: unchanged for ${seconds(at - since)}, ${seconds(at)} of at most ${seconds(timing.boundMs)}`,
      );
  }
  return { parts, settled: at - since >= timing.windowMs };
};
