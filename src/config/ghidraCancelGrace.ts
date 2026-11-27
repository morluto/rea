import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

import {
  ConfigurationError,
  type ConfigurationSettingIssue,
} from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const GHIDRA_CANCEL_GRACE_SETTING = "REA_GHIDRA_CANCEL_GRACE_MS";

/**
 * Grace applied when `REA_GHIDRA_CANCEL_GRACE_MS` is unset. Ghidra stops a
 * decompilation by disposing its native decompiler process; with real Ghidra
 * 12.2 the next request was served 4-19 ms after the cancel. Two seconds
 * absorbs a loaded host while staying well below the cost of the restart it
 * avoids.
 */
export const DEFAULT_GHIDRA_CANCEL_GRACE_MS = 2_000;

/**
 * About five times the slowest acknowledgement measured with real Ghidra
 * 12.2 (19 ms). A shorter grace closes sessions that would have answered.
 */
export const MINIMUM_GHIDRA_CANCEL_GRACE_MS = 100;

/**
 * One minute. While the grace runs, the cancelled call has not returned and
 * every request queued behind it waits, so a stuck bridge delays all of them
 * by the whole grace. One minute is the default tool-call deadline of the
 * pinned MCP client SDK: past it, a default client has stopped waiting for
 * those queued calls, so a longer grace keeps nothing it still wants.
 */
export const MAXIMUM_GHIDRA_CANCEL_GRACE_MS = 60_000;

/** The grace one session applies, and whether the launch environment chose it. */
export interface GhidraCancelGrace {
  readonly graceMs: number;
  readonly source: "default" | "setting";
}

export const DEFAULT_GHIDRA_CANCEL_GRACE: GhidraCancelGrace = {
  graceMs: DEFAULT_GHIDRA_CANCEL_GRACE_MS,
  source: "default",
};

const constraint = `${GHIDRA_CANCEL_GRACE_SETTING} must be a decimal integer from ${String(MINIMUM_GHIDRA_CANCEL_GRACE_MS)} to ${String(MAXIMUM_GHIDRA_CANCEL_GRACE_MS)} ms; the default is ${String(DEFAULT_GHIDRA_CANCEL_GRACE_MS)} ms`;

const schema = positiveDecimalIntegerSchema(
  MINIMUM_GHIDRA_CANCEL_GRACE_MS,
  MAXIMUM_GHIDRA_CANCEL_GRACE_MS,
  constraint,
);

/** Parse the launch value; an invalid value is refused, never replaced by the default. */
export const parseGhidraCancelGrace = (
  value: string | undefined,
): Result<GhidraCancelGrace, ConfigurationError> => {
  if (value === undefined) return ok(DEFAULT_GHIDRA_CANCEL_GRACE);
  const parsed = schema.safeParse(value);
  return parsed.success
    ? ok({ graceMs: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(`Invalid ${GHIDRA_CANCEL_GRACE_SETTING}`, {
          cause: parsed.error,
          settings: [{ setting: GHIDRA_CANCEL_GRACE_SETTING, constraint }],
          remediationAction: `Set ${GHIDRA_CANCEL_GRACE_SETTING} to a decimal integer from ${String(MINIMUM_GHIDRA_CANCEL_GRACE_MS)} to ${String(MAXIMUM_GHIDRA_CANCEL_GRACE_MS)} ms, or unset it for the ${String(DEFAULT_GHIDRA_CANCEL_GRACE_MS)} ms default, in the environment that starts REA, then restart REA. update_analysis_settings does not change it.`,
        }),
      );
};

/** Report an invalid launch value to doctor and registration validation. */
export const inspectGhidraCancelGrace = (
  environment: Readonly<Record<string, string | undefined>>,
  unresolvedSettings: ReadonlySet<string> = new Set(),
): readonly ConfigurationSettingIssue[] => {
  if (unresolvedSettings.has(GHIDRA_CANCEL_GRACE_SETTING)) return [];
  const parsed = parseGhidraCancelGrace(environment.REA_GHIDRA_CANCEL_GRACE_MS);
  return parsed.ok ? [] : parsed.error.settings;
};

/** The control, effective value, source and range, as one clause. */
export const ghidraCancelGraceFacts = (grace: GhidraCancelGrace): string =>
  `${GHIDRA_CANCEL_GRACE_SETTING} is ${String(grace.graceMs)} ms (source ${grace.source === "setting" ? "launch environment" : "default"}; default ${String(DEFAULT_GHIDRA_CANCEL_GRACE_MS)}, floor ${String(MINIMUM_GHIDRA_CANCEL_GRACE_MS)}, maximum ${String(MAXIMUM_GHIDRA_CANCEL_GRACE_MS)})`;
