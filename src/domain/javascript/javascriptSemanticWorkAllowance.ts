import { z } from "zod";
import { Budget } from "../budget.js";
import type { AnalysisCapturedOutput } from "../analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_PER_SOURCE_UNIT,
  MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
} from "../analysisResourceLimits.js";
import { analysisSettingLimit } from "../analysisSettingDefinitions.js";
import type { AnalysisSettingLimit } from "../analysisSettings.js";

/** Launch seed for CLI and future REA processes. */
export const JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_ENVIRONMENT =
  "REA_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES";

/** Reported-limit key that names this allowance across worker boundaries. */
export const JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT =
  "javascript_member_mutation_alias_state_limit";

/**
 * The analysis phase a work allowance refused. Facts that depend on it were
 * not examined; syntax facts gathered before it remain.
 */
export const javaScriptRefusedPhaseSchema = z.literal("member-mutations");

/** The effective allowance for one operation and where it came from. */
export interface JavaScriptMemberMutationAllowance {
  readonly aliasStates: number;
  readonly source: NonNullable<AnalysisSettingLimit["source"]>;
}

export const DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE: JavaScriptMemberMutationAllowance =
  {
    aliasStates: DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
    source: "default",
  };

/** Worker request field: the parent's resolved allowance for one source. */
export const javaScriptMemberMutationAllowanceSchema = z.strictObject({
  alias_states: z
    .int()
    .min(1)
    .max(MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES),
  source: z.enum(["default", "setting", "runtime", "request"]),
});
type JavaScriptMemberMutationAllowanceField = z.output<
  typeof javaScriptMemberMutationAllowanceSchema
>;

/** Encode an allowance for a worker request. */
export const javaScriptMemberMutationAllowanceField = (
  allowance: JavaScriptMemberMutationAllowance,
): JavaScriptMemberMutationAllowanceField => ({
  alias_states: allowance.aliasStates,
  source: allowance.source,
});

/** Decode the allowance a worker request carries. */
export const javaScriptMemberMutationAllowanceFromField = (
  field: JavaScriptMemberMutationAllowanceField,
): JavaScriptMemberMutationAllowance => ({
  aliasStates: field.alias_states,
  source: field.source,
});

/**
 * The allowance one source of `sourceLength` UTF-16 units is analyzed under.
 * Only the default grows with the source; a value a caller selected is the
 * caller's choice and applies unchanged.
 */
export const javaScriptMemberMutationAllowanceForSource = (
  allowance: JavaScriptMemberMutationAllowance,
  sourceLength: number,
): JavaScriptMemberMutationAllowance => {
  if (allowance.source !== "default") return allowance;
  const aliasStates = Math.min(
    MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
    Math.max(
      allowance.aliasStates,
      Math.max(0, sourceLength) *
        DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_PER_SOURCE_UNIT,
    ),
  );
  return aliasStates === allowance.aliasStates
    ? allowance
    : { ...allowance, aliasStates };
};

/**
 * The allowance a worker reports it reached, for the refusal its parent
 * rebuilds. The worker scales a default allowance by its source, so the
 * parent names that effective value instead of the one it sent. A report that
 * is not a value this allowance can take leaves the sent allowance in place.
 */
export const javaScriptMemberMutationAllowanceReached = (
  sent: JavaScriptMemberMutationAllowance,
  reportedLimits: Readonly<Record<string, unknown>> | null | undefined,
): JavaScriptMemberMutationAllowance => {
  const reported = reportedLimits?.[JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT];
  return typeof reported === "number" &&
    Number.isSafeInteger(reported) &&
    reported >= sent.aliasStates &&
    reported <= MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES &&
    (sent.source === "default" || reported === sent.aliasStates)
    ? { ...sent, aliasStates: reported }
    : sent;
};

const recovery = (allowance: JavaScriptMemberMutationAllowance): string => {
  const current = `The effective javascript.member_mutation_alias_states value is ${String(allowance.aliasStates)} alias states (source ${allowance.source}; default ${String(DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES)} or ${String(DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_PER_SOURCE_UNIT)} per source character if larger, maximum ${String(MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES)}).`;
  const change =
    allowance.aliasStates >= MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES
      ? "It is already at the maximum; do not increase it further. Select another complete source within the allowance."
      : `Raise it with update_analysis_settings on MCP, or ${JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_ENVIRONMENT} for CLI or future REA processes, then retry. Each scheduled state retains about 1–2 KiB of worker heap until its query finishes, so raise max_heap_mb with it (about 2 MiB per 1,024 states).`;
  return `${current} ${change} max_heap_mb, analysis_timeout_ms and semantic_precision alone do not admit the same source. Repeating the unchanged request fails the same way.`;
};

/**
 * The refusal for a source whose member-mutation phase exceeded the allowance.
 * Worker parents rebuild it from the allowance the worker reached, so every
 * adapter reports the same setting, value and recovery.
 */
export const javaScriptMemberMutationRefusal = (
  operation: string,
  allowance: JavaScriptMemberMutationAllowance,
  limits: Readonly<Record<string, unknown>> = {},
  capturedOutput?: AnalysisCapturedOutput,
): AnalysisResourceConstraintError => {
  const remediationAction = recovery(allowance);
  return new AnalysisResourceConstraintError(
    operation,
    "cpu",
    `JavaScript member-mutation analysis scheduled more than ${String(allowance.aliasStates)} alias states for one source`,
    {
      ...limits,
      [JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT]: allowance.aliasStates,
    },
    {
      retryable: false,
      remediationAction,
      limit: analysisSettingLimit(
        "javascript.member_mutation_alias_states",
        allowance.aliasStates,
        allowance.source,
      ),
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    },
  );
};

/** Whether a thrown value is this allowance's refusal. */
export const isJavaScriptMemberMutationRefusal = (
  cause: unknown,
): cause is AnalysisResourceConstraintError =>
  cause instanceof AnalysisResourceConstraintError &&
  reportsJavaScriptMemberMutationRefusal(cause.reportedLimits);

/** Whether a worker reported this allowance as the limit it reached. */
export const reportsJavaScriptMemberMutationRefusal = (
  limits: Readonly<Record<string, unknown>> | null | undefined,
): boolean =>
  typeof limits?.[JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT] === "number";

/**
 * Work meter for one analysis phase. Charging past the allowance refuses the
 * phase before its retained state can exhaust the worker heap; a partial
 * mutation index would let later reads keep stale values.
 */
export class JavaScriptSemanticWorkMeter {
  readonly #aliasStates: Budget;

  constructor(
    readonly allowance: JavaScriptMemberMutationAllowance = DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE,
  ) {
    this.#aliasStates = new Budget(allowance.aliasStates);
  }

  charge(units = 1): void {
    this.#aliasStates.charge(units, () =>
      javaScriptMemberMutationRefusal(
        "analyze_javascript_semantics",
        this.allowance,
      ),
    );
  }
}
