import type { Stats } from "node:fs";

/**
 * Windows advances a file's ChangeTime shortly after it is written, without any
 * content change: security components attach catalog and file-hash extended
 * attributes asynchronously. A baseline captured while that is still in flight
 * disagrees with a later observation and reports an untouched file as changed.
 *
 * The drift window below is only an upper bound on when a write's ChangeTime has
 * finished moving, so a baseline is taken again until two observations agree.
 * That keeps `ctime` at full strength as a rewrite signal instead of dropping it,
 * which Windows needs because restoring the modification time is possible and
 * ordinary tools cannot restore the ChangeTime.
 */
const WINDOWS_CHANGE_TIME_DRIFT_MS = 2_000;

/** Settle a freshly written file's ChangeTime before recording it as a baseline. */
const SETTLE_POLL_MS = 25;

/** Give up settling rather than stall admission when ChangeTime never rests. */
const SETTLE_MAX_POLLS = 40;

export interface ChangeTimeSettleSeams {
  readonly platform?: NodeJS.Platform | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined;
}

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const changeTimeMs = (stats: Stats): number =>
  typeof stats.ctimeMs === "number" ? stats.ctimeMs : Number.NaN;

/**
 * Whether an observed ChangeTime can still move on its own, so recording it now
 * would create a baseline a later observation is entitled to disagree with.
 */
export const changeTimeMayStillDrift = (
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
  return now - changeTime < WINDOWS_CHANGE_TIME_DRIFT_MS;
};

/**
 * Observe until one ChangeTime is stable across two reads, then return it as the
 * baseline. Only a file whose ChangeTime is still inside the drift window is
 * re-observed, so an established file costs exactly one read.
 *
 * Returns the last observation when the window never yields a stable pair: the
 * caller's comparisons still see that value, and refusing to admit a readable
 * file would trade a false "changed" report for a failure to inspect it.
 */
export const settleChangeTimeBaseline = async (
  read: () => Promise<Stats>,
  seams: ChangeTimeSettleSeams = {},
): Promise<Stats> => {
  const sleep = seams.sleep ?? defaultSleep;
  let previous = await read();
  if (!changeTimeMayStillDrift(previous, seams)) return previous;
  for (let poll = 0; poll < SETTLE_MAX_POLLS; poll += 1) {
    await sleep(SETTLE_POLL_MS);
    const current = await read();
    if (changeTimeMs(current) === changeTimeMs(previous)) return current;
    previous = current;
    if (!changeTimeMayStillDrift(current, seams)) return current;
  }
  return previous;
};
