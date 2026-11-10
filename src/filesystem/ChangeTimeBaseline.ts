import type { Stats } from "node:fs";

import {
  applyWindowsChangeTimeSnapshot,
  resolveWindowsChangeTimeSettle,
  type WindowsChangeTimeSettleLimits,
} from "../config/windowsChangeTimeSettle.js";

/**
 * Windows advances a file's ChangeTime shortly after it is written, without any
 * content change: security components attach catalog and file-hash extended
 * attributes asynchronously. A baseline captured while that is still in flight
 * disagrees with a later observation and reports an untouched file as changed.
 *
 * The drift window is only an upper bound on when a write's ChangeTime has
 * finished moving. `REA_WINDOWS_CHANGE_TIME_DRIFT_MS`,
 * `REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS`, and
 * `REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS` keep today's 2000 ms, 25 ms, and
 * 40-poll defaults. That keeps `ctime` at full strength as a rewrite signal
 * instead of dropping it, which Windows needs because restoring the
 * modification time is possible and ordinary tools cannot restore the
 * ChangeTime.
 */

export interface ChangeTimeSettleSeams {
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined;
  /** Launch environment. Omission reads `process.env`. */
  readonly environment?:
    | Readonly<Record<string, string | undefined>>
    | undefined;
  /** Already resolved budget. Omission parses `environment`. */
  readonly limits?: WindowsChangeTimeSettleLimits | undefined;
  /** Cancels the wait; the last observation is not returned once aborted. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Builds the error a cancellation throws. Callers that recognise their own
   * typed cancellation must supply it: throwing the raw `signal.reason` reads
   * as a read failure to everyone matching on their own error class.
   */
  readonly cancellationError?: ((reason: unknown) => Error) | undefined;
}

const limitsFrom = (
  seams: ChangeTimeSettleSeams,
): WindowsChangeTimeSettleLimits => {
  if (seams.limits !== undefined) return seams.limits;
  const resolved = resolveWindowsChangeTimeSettle(
    seams.environment ?? process.env,
  );
  if (!resolved.ok) throw resolved.error;
  return applyWindowsChangeTimeSnapshot(resolved.value);
};

/** Stop settling as soon as the owning operation is cancelled. */
const throwIfAborted = (seams: ChangeTimeSettleSeams): void => {
  if (seams.signal?.aborted !== true) return;
  const reason = seams.signal.reason;
  throw seams.cancellationError ? seams.cancellationError(reason) : reason;
};

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const changeTimeMs = (stats: Stats): number =>
  typeof stats.ctimeMs === "number" ? stats.ctimeMs : Number.NaN;

/**
 * Whether an observed ChangeTime can still move on its own, so recording it now
 * would create a baseline a later observation is entitled to disagree with.
 */
const changeTimeMayStillDrift = (
  stats: Stats,
  seams: ChangeTimeSettleSeams = {},
): boolean => {
  const platform = seams.platform ?? process.platform;
  if (platform !== "win32") return false;
  const changeTime = changeTimeMs(stats);
  // An unreadable ChangeTime cannot establish that it has settled; re-observation
  // is the only way to obtain a comparable value.
  if (!Number.isFinite(changeTime)) return true;
  const now = seams.now?.() ?? Date.now();
  return now - changeTime < limitsFrom(seams).driftMs;
};

/**
 * Observe until the ChangeTime itself has aged out of the drift window, then
 * return it as the baseline. Waiting for two consecutive reads to agree is not
 * enough: two observations taken before Windows performs a delayed update agree
 * with each other and disagree with every later one.
 *
 * Only a ChangeTime still inside the window is re-observed, so an established
 * file costs exactly one read.
 *
 * Returns the last observation if the wait budget runs out: the caller's
 * comparisons still see that value, and refusing to admit a readable file would
 * trade a false "changed" report for a failure to inspect it.
 */
export const settleChangeTimeBaseline = async (
  read: () => Promise<Stats>,
  seams: ChangeTimeSettleSeams = {},
): Promise<Stats> => {
  const limits = limitsFrom(seams);
  const settled = { ...seams, limits };
  const sleep = seams.sleep ?? defaultSleep;
  throwIfAborted(seams);
  let observed = await read();
  for (let poll = 0; poll < limits.maxPolls; poll += 1) {
    if (!changeTimeMayStillDrift(observed, settled)) return observed;
    // A settle window is bounded by driftMs, not by the poll budget, so a
    // cancelled scope must not keep an inventory waiting it out.
    throwIfAborted(seams);
    await sleep(limits.pollMs);
    throwIfAborted(seams);
    observed = await read();
  }
  throwIfAborted(seams);
  return observed;
};
