import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import {
  fixedAllowanceOptions,
  type FixedAllowance,
} from "../fixedAllowanceRemediation.js";

/**
 * Alias states one source's member-mutation phase may schedule. Each state is
 * retained until its query finishes, at roughly 1–2 KiB, so the allowance stays
 * well below the default 1 GiB worker heap. Published bundles up to 395 KB
 * schedule at most about 123,000 states.
 */
export const JAVASCRIPT_MEMBER_MUTATION_WORK_ALLOWANCE = 524_288;

/** Reported-limit key that names this allowance across worker boundaries. */
export const JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT =
  "javascript_member_mutation_alias_state_limit";

const ALLOWANCE_NAME = "The JavaScript member-mutation work allowance";

/** Fixed allowance facts for a refusal rebuilt from reported limits. */
export const javaScriptSemanticWorkAllowance = (
  limits: Readonly<Record<string, unknown>> | null | undefined,
):
  | { readonly retryable: false; readonly fixedAllowance: FixedAllowance }
  | undefined => {
  const limit = limits?.[JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT];
  return typeof limit === "number"
    ? fixedAllowanceOptions(ALLOWANCE_NAME, "work", {
        limit,
        unit: "alias states",
      })
    : undefined;
};

/**
 * Work meter for one analysis phase. Charging past the fixed allowance refuses
 * the phase before its retained state can exhaust the worker heap; a partial
 * mutation index would let later reads keep stale values.
 */
export class JavaScriptSemanticWorkMeter {
  #used = 0;

  constructor(
    readonly allowance: number = JAVASCRIPT_MEMBER_MUTATION_WORK_ALLOWANCE,
  ) {}

  charge(units = 1): void {
    this.#used += units;
    if (this.#used <= this.allowance) return;
    const limits = { [JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT]: this.allowance };
    throw new AnalysisResourceConstraintError(
      "analyze_javascript_semantics",
      "cpu",
      `JavaScript member-mutation analysis scheduled more than ${String(this.allowance)} alias states for one source`,
      limits,
      javaScriptSemanticWorkAllowance(limits),
    );
  }
}
