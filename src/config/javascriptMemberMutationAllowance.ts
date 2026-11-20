import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
  MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
} from "../domain/analysisResourceLimits.js";
import type { AnalysisSettingValues } from "../domain/analysisSettings.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_ENVIRONMENT,
  type JavaScriptMemberMutationAllowance,
} from "../domain/javascript/javascriptSemanticWorkAllowance.js";
import { err, ok, type Result } from "../domain/result.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

const constraint = `${JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_ENVIRONMENT} must be a decimal integer from 1 to ${String(MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES)} alias states; the default is ${String(DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES)}.`;

/** Optional decimal count for the JavaScript member-mutation work allowance. */
export const javaScriptMemberMutationAliasStatesSchema =
  positiveDecimalIntegerSchema(
    1,
    MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
    constraint,
  );

/**
 * Resolve the allowance for one accepted operation: a runtime override wins,
 * then the launch seed, then the default. A malformed seed is refused before
 * analysis, never replaced by the default.
 */
export const resolveJavaScriptMemberMutationAllowance = (
  environment: Readonly<Record<string, string | undefined>> | undefined,
  overrides?: Readonly<Partial<AnalysisSettingValues>>,
): Result<JavaScriptMemberMutationAllowance, ConfigurationError> => {
  const override = overrides?.["javascript.member_mutation_alias_states"];
  if (override !== undefined)
    return ok({ aliasStates: override, source: "runtime" });
  const value =
    environment?.[JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_ENVIRONMENT];
  if (value === undefined)
    return ok({
      aliasStates: DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
      source: "default",
    });
  const parsed = javaScriptMemberMutationAliasStatesSchema.safeParse(value);
  return parsed.success
    ? ok({ aliasStates: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(constraint, {
          remediationAction: `On a running MCP session, call update_analysis_settings with ${JSON.stringify({ changes: [{ setting: "javascript.member_mutation_alias_states", action: "set", value: DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES }] })}, then retry. For CLI or future REA processes, correct ${JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_ENVIRONMENT} in the launch environment.`,
          settings: [
            {
              setting: JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_ENVIRONMENT,
              constraint,
            },
          ],
        }),
      );
};
