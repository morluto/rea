import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

import type { AnalysisControlLimit } from "../domain/analysisSettings.js";
import {
  ConfigurationError,
  type ConfigurationSettingIssue,
} from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING =
  "REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS";

/** How often a waiting save re-checks the publication lease. */
export const GHIDRA_CHECKPOINT_SAVE_POLL_MS = 50;

/** Wait applied when `REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS` is unset. */
export const DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT_MS = 30_000;

/**
 * One poll interval. A shorter wait would report the checkpoint busy without
 * observing the lease a second time, which is a refusal and not a wait.
 */
export const MINIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS =
  GHIDRA_CHECKPOINT_SAVE_POLL_MS;

/**
 * Ten minutes. The wait runs inside `close_binary` and the first save of a
 * startup, and it covers only another session's publication: one copy and
 * sync of a packed Program and a manifest rename. A lease still held after
 * that long is a stalled publisher, which the busy refusal names so the caller
 * can act instead of leaving the close blocked. The MCP client's own request
 * deadline is separate and unknown to REA; a wait above it leaves the client
 * giving up while the close continues, so recovery says to stay below it.
 */
export const MAXIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS = 600_000;

/** The wait one session applies, and whether the launch environment chose it. */
export interface GhidraCheckpointSaveWait {
  readonly waitMs: number;
  readonly source: "default" | "setting";
}

export const DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT: GhidraCheckpointSaveWait = {
  waitMs: DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT_MS,
  source: "default",
};

const constraint = `${GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING} must be a decimal integer from ${String(MINIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS)} to ${String(MAXIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS)} ms; the default is ${String(DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT_MS)} ms`;

const schema = positiveDecimalIntegerSchema(
  MINIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS,
  MAXIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS,
  constraint,
);

/** Parse the launch value; an invalid value is refused, never replaced by the default. */
export const parseGhidraCheckpointSaveWait = (
  value: string | undefined,
): Result<GhidraCheckpointSaveWait, ConfigurationError> => {
  if (value === undefined) return ok(DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT);
  const parsed = schema.safeParse(value);
  return parsed.success
    ? ok({ waitMs: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(
          `Invalid ${GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING}`,
          {
            cause: parsed.error,
            settings: [
              { setting: GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING, constraint },
            ],
            remediationAction: `Set ${GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING} to a decimal integer from ${String(MINIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS)} to ${String(MAXIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS)} ms, or unset it for the ${String(DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT_MS)} ms default, in the environment that starts REA, then restart REA. update_analysis_settings does not change it.`,
          },
        ),
      );
};

/** Report an invalid launch value to doctor and registration validation. */
export const inspectGhidraCheckpointSaveWait = (
  environment: Readonly<Record<string, string | undefined>>,
  unresolvedSettings: ReadonlySet<string> = new Set(),
): readonly ConfigurationSettingIssue[] => {
  if (unresolvedSettings.has(GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING)) return [];
  const parsed = parseGhidraCheckpointSaveWait(
    environment.REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS,
  );
  return parsed.ok ? [] : parsed.error.settings;
};

/** Structured facts of the wait a busy refusal exhausted. */
export const ghidraCheckpointSaveWaitLimit = (
  wait: GhidraCheckpointSaveWait,
): AnalysisControlLimit => ({
  control_kind: "environment",
  environment: GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING,
  effective_value: wait.waitMs,
  unit: "ms",
  minimum: MINIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS,
  maximum: MAXIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS,
  default_value: DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT_MS,
  applies_at: "next_startup",
});

/** The control, effective value, source and range, as one clause. */
export const ghidraCheckpointSaveWaitFacts = (
  wait: GhidraCheckpointSaveWait,
): string =>
  `${GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING} is ${String(wait.waitMs)} ms (source ${wait.source === "setting" ? "launch environment" : "default"}; default ${String(DEFAULT_GHIDRA_CHECKPOINT_SAVE_WAIT_MS)}, floor ${String(MINIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS)}, maximum ${String(MAXIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS)})`;

/** Recovery for a save that waited the whole bound. */
export const ghidraCheckpointSaveWaitRecovery = (
  wait: GhidraCheckpointSaveWait,
): string =>
  `Wait for that session's save to finish, then repeat this call unchanged. If that save changes the checkpoint first, the repeated call reports that this session's checkpoint was superseded and names the next step, normally reopening the target. This session waited its whole save wait: ${ghidraCheckpointSaveWaitFacts(wait)}. ${
    wait.waitMs < MAXIMUM_GHIDRA_CHECKPOINT_SAVE_WAIT_MS
      ? `To wait longer within one call, set ${GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING} in the environment that starts REA and restart REA`
      : `${GHIDRA_CHECKPOINT_SAVE_WAIT_SETTING} is already at its maximum`
  }; update_analysis_settings does not change it, and it does not shorten the other session's save. Raising it cannot make an MCP client wait longer: that client's own request deadline is separate and unknown to REA, so keep the wait below it.`;
