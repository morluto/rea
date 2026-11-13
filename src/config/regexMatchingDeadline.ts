import {
  DEFAULT_REGEX_MATCHING_DEADLINE_MS,
  MAXIMUM_REGEX_MATCHING_DEADLINE_MS,
} from "../domain/analysisResourceLimits.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { currentAnalysisSettingOverride } from "../domain/analysisOperationSnapshot.js";
import { err, ok, type Result } from "../domain/result.js";

export const REGEX_MATCHING_DEADLINE_SETTING = "REA_REGEX_MATCHING_DEADLINE_MS";

/** Effective regex matching deadline and where its value came from. */
export interface RegexMatchingDeadline {
  readonly deadlineMs: number;
  readonly source: "default" | "setting" | "runtime";
}

export const DEFAULT_REGEX_MATCHING_DEADLINE: RegexMatchingDeadline = {
  deadlineMs: DEFAULT_REGEX_MATCHING_DEADLINE_MS,
  source: "default",
};

const regexMatchingDeadlineConstraint = `${REGEX_MATCHING_DEADLINE_SETTING} must be a positive decimal integer from 1 to ${String(MAXIMUM_REGEX_MATCHING_DEADLINE_MS)} ms; the default is ${String(DEFAULT_REGEX_MATCHING_DEADLINE_MS)} ms. Node schedules a delay above that maximum as 1 ms, so a larger value is refused.`;

/** Optional decimal millisecond count for the supervised regex matching deadline. */
export const regexMatchingDeadlineMsSchema = positiveDecimalIntegerSchema(
  1,
  MAXIMUM_REGEX_MATCHING_DEADLINE_MS,
  regexMatchingDeadlineConstraint,
);

/** Resolve the effective deadline from one environment value. */
export const parseRegexMatchingDeadline = (
  value: string | undefined,
): Result<RegexMatchingDeadline, ConfigurationError> => {
  if (value === undefined) return ok(DEFAULT_REGEX_MATCHING_DEADLINE);
  const parsed = regexMatchingDeadlineMsSchema.safeParse(value);
  return parsed.success
    ? ok({ deadlineMs: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(regexMatchingDeadlineConstraint, {
          settings: [
            {
              setting: REGEX_MATCHING_DEADLINE_SETTING,
              constraint: regexMatchingDeadlineConstraint,
            },
          ],
        }),
      );
};

/**
 * Resolve the deadline from a composition root's selected environment. An
 * invalid setting is refused, not ignored. Callers that already resolved it
 * at startup pass that value through instead of reading the environment again.
 */
export const resolveRegexMatchingDeadline = (
  environment: Readonly<Record<string, string | undefined>>,
): RegexMatchingDeadline => {
  const override = currentAnalysisSettingOverride("regex.matching_deadline_ms");
  if (override !== undefined)
    return { deadlineMs: override, source: "runtime" };
  const parsed = parseRegexMatchingDeadline(
    environment[REGEX_MATCHING_DEADLINE_SETTING],
  );
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

const regexMatchingDeadlineFacts = (deadline: RegexMatchingDeadline): string =>
  `The effective ${REGEX_MATCHING_DEADLINE_SETTING} value is ${String(deadline.deadlineMs)} ms (source ${deadline.source}; default ${String(DEFAULT_REGEX_MATCHING_DEADLINE_MS)} ms, floor 1 ms, maximum ${String(MAXIMUM_REGEX_MATCHING_DEADLINE_MS)} ms).`;

/** Recovery after this REA process has exited. The next invocation reads the launch seed. */
export const regexMatchingDeadlineRecovery = (
  deadline: RegexMatchingDeadline,
): string =>
  [
    regexMatchingDeadlineFacts(deadline),
    `Set ${REGEX_MATCHING_DEADLINE_SETTING} in the environment that starts the next REA invocation. It must be a positive decimal integer from 1 to ${String(MAXIMUM_REGEX_MATCHING_DEADLINE_MS)}.`,
    "The worker old-generation heap does not raise this deadline.",
  ].join(" ");

/** Recovery while the same REA session can still call update_analysis_settings. */
export const regexMatchingDeadlineContinuingRecovery = (
  deadline: RegexMatchingDeadline,
): string =>
  [
    regexMatchingDeadlineFacts(deadline),
    `Call update_analysis_settings with setting regex.matching_deadline_ms. It applies to the next match in this session. The launch seed remains ${REGEX_MATCHING_DEADLINE_SETTING}.`,
    "The worker old-generation heap does not raise this deadline.",
  ].join(" ");
