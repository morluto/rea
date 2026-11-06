import { setTimeout as delay } from "node:timers/promises";

import {
  appFileDigests,
  type SettleTiming,
} from "../../domain/desktop/appSettle.js";

/**
 * The last completed data/get answer of a settled read, whether the app's
 * files had held for the window by then, and whether the bound cut a read
 * still in flight.
 */
export interface SettledRead {
  readonly parts: readonly unknown[];
  readonly settled: boolean;
  readonly readCut: boolean;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Read an app's data/get every interval until each file's bytes have held
 * for the window, counted from the read that returned them, or until the
 * bound, as the exported verifier does; `waiting` hears why it reads again.
 * No read starts at or past the bound, and one in flight there is cut.
 */
export const settledAppData = async (
  read: (signal: AbortSignal) => Promise<readonly unknown[]>,
  timing: SettleTiming,
  signal: AbortSignal,
  waiting: (message: string) => Promise<void>,
): Promise<SettledRead> => {
  const start = performance.now();
  const elapsed = () => performance.now() - start;
  // The first read is the one a grade needs, so only its own timeout bounds it.
  let parts = await read(signal);
  let files = appFileDigests(parts);
  // Offsets from the first read's start: when the last completed read began,
  // and when a read first returned the bytes it holds.
  let began = 0;
  let since = elapsed();
  const unsettled = () => began - since < timing.windowMs;
  while (unsettled()) {
    // Reads come an interval apart, and the one that can settle the files as soon as the window allows.
    const next = Math.max(
      Math.min(began + timing.intervalMs, since + timing.windowMs),
      elapsed(),
    );
    if (next >= timing.boundMs)
      return { parts, settled: false, readCut: false };
    await delay(Math.max(0, next - elapsed()), undefined, { signal });
    const at = Math.max(next, elapsed());
    if (at >= timing.boundMs) return { parts, settled: false, readCut: false };
    // A timeout takes whole milliseconds.
    const bound = AbortSignal.timeout(
      Math.max(1, Math.floor(timing.boundMs - at)),
    );
    let latest: readonly unknown[];
    try {
      latest = await read(AbortSignal.any([signal, bound]));
    } catch (cause: unknown) {
      if (bound.aborted && !signal.aborted)
        return { parts, settled: false, readCut: true };
      throw cause;
    }
    began = at;
    parts = latest;
    const digests = appFileDigests(latest);
    if (digests !== files) {
      since = elapsed();
      files = digests;
    }
    if (unsettled())
      await waiting(
        `waiting for the app's files to hold for ${seconds(timing.windowMs)}: unchanged for ${seconds(Math.max(0, began - since))}, ${seconds(began)} of at most ${seconds(timing.boundMs)}`,
      );
  }
  return { parts, settled: true, readCut: false };
};
