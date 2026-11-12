import { z } from "zod";

import { currentAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import {
  DEFAULT_WINDOWS_CHANGE_TIME_DRIFT_MS,
  DEFAULT_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
  DEFAULT_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
  MAXIMUM_WINDOWS_CHANGE_TIME_DRIFT_MS,
  MAXIMUM_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
  MAXIMUM_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
} from "../domain/analysisResourceLimits.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

const decimalInteger = /^[1-9]\d*$/u;

interface WindowsChangeTimeBound {
  readonly setting: string;
  readonly defaultValue: number;
  readonly floor: number;
  readonly maximum: number;
  readonly unit: "ms" | "polls";
}

/**
 * How long a fresh Windows ChangeTime may still move after a write.
 * Unset keeps the 2000 ms window this admission used before the setting existed.
 */
export const WINDOWS_CHANGE_TIME_DRIFT_MS = {
  setting: "REA_WINDOWS_CHANGE_TIME_DRIFT_MS",
  defaultValue: DEFAULT_WINDOWS_CHANGE_TIME_DRIFT_MS,
  floor: 1,
  maximum: MAXIMUM_WINDOWS_CHANGE_TIME_DRIFT_MS,
  unit: "ms",
} as const satisfies WindowsChangeTimeBound;

/** Delay between ChangeTime observations. Unset keeps the 25 ms poll. */
export const WINDOWS_CHANGE_TIME_SETTLE_POLL_MS = {
  setting: "REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS",
  defaultValue: DEFAULT_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
  floor: 1,
  maximum: MAXIMUM_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
  unit: "ms",
} as const satisfies WindowsChangeTimeBound;

/**
 * How many times admission re-reads a ChangeTime that is still inside the
 * drift window. Unset keeps 40 polls, then returns the last observation.
 */
export const WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS = {
  setting: "REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS",
  defaultValue: DEFAULT_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
  floor: 1,
  maximum: MAXIMUM_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
  unit: "polls",
} as const satisfies WindowsChangeTimeBound;

/** Rejected launch value for one Windows ChangeTime settle setting. */
export interface WindowsChangeTimeSettingFailure {
  readonly setting: string;
  readonly currentValue: string;
  readonly source: "setting";
  readonly defaultValue: number;
  readonly floor: number;
  readonly maximum: number;
  readonly unit: "ms" | "polls";
  readonly update_mode: "runtime";
}

/** Effective settle budget and whether each part came from the default or a setting. */
export interface WindowsChangeTimeSettleLimits {
  readonly driftMs: number;
  readonly driftSource: "default" | "setting" | "runtime";
  readonly pollMs: number;
  readonly pollSource: "default" | "setting" | "runtime";
  readonly maxPolls: number;
  readonly maxPollsSource: "default" | "setting" | "runtime";
}

const windowsChangeTimeSettingFailure = (
  bound: WindowsChangeTimeBound,
  currentValue: string,
): WindowsChangeTimeSettingFailure => ({
  setting: bound.setting,
  currentValue,
  source: "setting",
  defaultValue: bound.defaultValue,
  floor: bound.floor,
  maximum: bound.maximum,
  unit: bound.unit,
  update_mode: "runtime",
});

/** Name the rejected value, its source, and the allowed range. */
const windowsChangeTimeSettingMessage = (
  failure: WindowsChangeTimeSettingFailure,
): string =>
  `The supplied ${failure.setting} value is ${failure.currentValue} ${failure.unit} (source ${failure.source}; default ${String(failure.defaultValue)} ${failure.unit}, floor ${String(failure.floor)} ${failure.unit}, maximum ${String(failure.maximum)} ${failure.unit}). windows change-time settings can be changed at runtime with update_analysis_settings. The launch seed ${failure.setting} must be a positive decimal integer from ${String(failure.floor)} to ${String(failure.maximum)}. The rejected value is not active.`;

const inRange = (bound: WindowsChangeTimeBound, value: string): boolean => {
  if (!decimalInteger.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= BigInt(bound.floor) && parsed <= BigInt(bound.maximum);
};

/** Decimal integer inside one settle setting's floor and maximum. */
export const windowsChangeTimeSettingSchema = (bound: WindowsChangeTimeBound) =>
  z
    .string()
    .superRefine((value, context) => {
      if (inRange(bound, value)) return;
      const failure = windowsChangeTimeSettingFailure(bound, value);
      context.addIssue({
        code: "custom",
        message: windowsChangeTimeSettingMessage(failure),
        params: {
          update_mode: failure.update_mode,
        },
      });
    })
    .transform(Number);

export const windowsChangeTimeDriftMsSchema = windowsChangeTimeSettingSchema(
  WINDOWS_CHANGE_TIME_DRIFT_MS,
);
export const windowsChangeTimeSettlePollMsSchema =
  windowsChangeTimeSettingSchema(WINDOWS_CHANGE_TIME_SETTLE_POLL_MS);
export const windowsChangeTimeSettleMaxPollsSchema =
  windowsChangeTimeSettingSchema(WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS);

const WINDOWS_CHANGE_TIME_OVERRIDES = {
  [WINDOWS_CHANGE_TIME_DRIFT_MS.setting]: "windows.change_time_drift_ms",
  [WINDOWS_CHANGE_TIME_SETTLE_POLL_MS.setting]:
    "windows.change_time_settle_poll_ms",
  [WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS.setting]:
    "windows.change_time_settle_max_polls",
} as const;

const readBound = (
  bound: WindowsChangeTimeBound,
  environment: Readonly<Record<string, string | undefined>>,
  failures: WindowsChangeTimeSettingFailure[],
): number | undefined => {
  const value = environment[bound.setting];
  if (value === undefined) return undefined;
  const parsed = windowsChangeTimeSettingSchema(bound).safeParse(value);
  if (parsed.success) return parsed.data;
  const override =
    WINDOWS_CHANGE_TIME_OVERRIDES[
      bound.setting as keyof typeof WINDOWS_CHANGE_TIME_OVERRIDES
    ];
  if (currentAnalysisOperationSnapshot()?.overrides[override] !== undefined)
    return undefined;
  failures.push(windowsChangeTimeSettingFailure(bound, value));
  return undefined;
};

/** Resolve the settle budget from one environment. Invalid values are refused. */
export const resolveWindowsChangeTimeSettle = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<WindowsChangeTimeSettleLimits, ConfigurationError> => {
  const failures: WindowsChangeTimeSettingFailure[] = [];
  const driftMs = readBound(
    WINDOWS_CHANGE_TIME_DRIFT_MS,
    environment,
    failures,
  );
  const pollMs = readBound(
    WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
    environment,
    failures,
  );
  const maxPolls = readBound(
    WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
    environment,
    failures,
  );
  if (failures.length > 0)
    return err(
      new ConfigurationError(
        failures.map(windowsChangeTimeSettingMessage).join(" "),
        {
          settings: failures.map((failure) => ({
            setting: failure.setting,
            constraint: windowsChangeTimeSettingMessage(failure),
            update_mode: failure.update_mode,
          })),
        },
      ),
    );
  return ok({
    driftMs: driftMs ?? WINDOWS_CHANGE_TIME_DRIFT_MS.defaultValue,
    driftSource: driftMs === undefined ? "default" : "setting",
    pollMs: pollMs ?? WINDOWS_CHANGE_TIME_SETTLE_POLL_MS.defaultValue,
    pollSource: pollMs === undefined ? "default" : "setting",
    maxPolls: maxPolls ?? WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS.defaultValue,
    maxPollsSource: maxPolls === undefined ? "default" : "setting",
  });
};

/** Apply the accepted operation snapshot. An explicit caller budget is left alone. */
export const applyWindowsChangeTimeSnapshot = (
  limits: WindowsChangeTimeSettleLimits,
): WindowsChangeTimeSettleLimits => {
  const overrides = currentAnalysisOperationSnapshot()?.overrides;
  if (overrides === undefined) return limits;
  const driftMs = overrides["windows.change_time_drift_ms"];
  const pollMs = overrides["windows.change_time_settle_poll_ms"];
  const maxPolls = overrides["windows.change_time_settle_max_polls"];
  return {
    driftMs: driftMs ?? limits.driftMs,
    driftSource: driftMs === undefined ? limits.driftSource : "runtime",
    pollMs: pollMs ?? limits.pollMs,
    pollSource: pollMs === undefined ? limits.pollSource : "runtime",
    maxPolls: maxPolls ?? limits.maxPolls,
    maxPollsSource: maxPolls === undefined ? limits.maxPollsSource : "runtime",
  };
};
