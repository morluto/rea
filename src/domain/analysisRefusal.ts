import type { AnalysisCallerLifetime } from "./analysisErrorBase.js";
import type { AnalysisSettingLimit } from "./analysisSettings.js";
import { analysisSettingDefinition } from "./analysisSettingDefinitions.js";
import {
  fixedAllowanceRemediation,
  type FixedAllowance,
} from "./fixedAllowanceRemediation.js";
import type { JsonValue } from "./jsonValue.js";

/** A caller-addressable request field, as a path into the operation's input. */
export type RefusalField = readonly (string | number)[];

/** A selector that matched several candidates where the operation needs one. */
export interface AmbiguousSelector {
  /** Request field whose value would choose one candidate. */
  readonly field: RefusalField;
  /** Every matching candidate, in the producer's order. */
  readonly candidates: readonly JsonValue[];
}

/**
 * A deliberate refusal the producer typed, attributed to the request's
 * operation. Each variant owns its recovery, so presentation needs no generic
 * fallback for it:
 *
 * - `fixed_ceiling`: a release-fixed allowance (`FixedAllowance`) with its
 *   optional limit, unit and narrowing step.
 * - `adjustable_budget`: an agent-adjustable setting or per-call parameter
 *   (`AnalysisSettingLimit`) with its control, unit and range.
 * - `ambiguous_selector`: a selector that matched several candidates.
 */
export type AnalysisRefusal =
  | {
      readonly kind: "fixed_ceiling";
      readonly operation: string;
      readonly ceiling: FixedAllowance;
    }
  | {
      readonly kind: "adjustable_budget";
      readonly operation: string;
      readonly budget: AnalysisSettingLimit;
    }
  | {
      readonly kind: "ambiguous_selector";
      readonly operation: string;
      readonly selector: AmbiguousSelector;
    };

const fieldName = (field: RefusalField): string => field.map(String).join(".");

const UNCHANGED = "Repeating the unchanged request is not expected to succeed.";

const adjustableBudgetRemediation = (
  operation: string,
  budget: AnalysisSettingLimit,
  callerLifetime: AnalysisCallerLifetime,
): string => {
  const { unit, minimum, maximum, effective_value: value } = budget;
  const control = budget.parameter ?? budget.setting;
  const range = `${String(minimum)}..${String(maximum)} ${unit}`;
  const effective =
    value === null
      ? `The effective ${control} value is unknown`
      : `${operation} reached its ${control} budget of ${String(value)} ${unit}${budget.source === undefined ? "" : ` (source ${budget.source})`}`;
  if (value !== null && value >= maximum)
    return `${effective}. ${control} is already at its maximum (${range}); narrow the request or select a smaller input. ${UNCHANGED}`;
  const environment = analysisSettingDefinition(budget.setting).environment;
  const change =
    budget.parameter !== undefined &&
    (budget.update_mode === "parameter" ||
      (callerLifetime === "invocation" && environment === undefined))
      ? `Pass a larger ${budget.parameter} on the next ${operation} call`
      : callerLifetime === "invocation"
        ? `Set ${environment ?? budget.setting} for the next invocation`
        : budget.update_mode === "runtime"
          ? `Raise ${budget.setting} with update_analysis_settings`
          : `Set ${environment ?? budget.setting} in the environment that starts REA, then restart REA`;
  return `${effective}. ${change} (range ${range}), then retry.`;
};

/**
 * The one recovery for a typed refusal. Total over every variant: adding a
 * variant fails compilation here until it has its own recovery.
 */
export const analysisRefusalRemediation = (
  refusal: AnalysisRefusal,
  callerLifetime: AnalysisCallerLifetime = "continuing",
): string => {
  switch (refusal.kind) {
    case "fixed_ceiling": {
      const { ceiling } = refusal;
      const base = fixedAllowanceRemediation(ceiling.name, ceiling.kind);
      return ceiling.narrowing === undefined
        ? base
        : `${base} ${ceiling.narrowing}`;
    }
    case "adjustable_budget":
      return adjustableBudgetRemediation(
        refusal.operation,
        refusal.budget,
        callerLifetime,
      );
    case "ambiguous_selector": {
      const { field, candidates } = refusal.selector;
      return `Set ${fieldName(field)} to exactly one of the ${String(candidates.length)} candidates in details.refusal.candidates, then retry ${refusal.operation}. ${UNCHANGED}`;
    }
  }
};

/** Outcome sentence for a refusal whose producer authored none. */
export const analysisRefusalMessage = (
  refusal: AnalysisRefusal,
): string | undefined =>
  refusal.kind === "ambiguous_selector"
    ? `${fieldName(refusal.selector.field)} matches ${String(refusal.selector.candidates.length)} candidates; ${refusal.operation} needs exactly one.`
    : undefined;

/** Machine-readable refusal facts projected under `details.refusal`. */
export const analysisRefusalDetails = (
  refusal: AnalysisRefusal,
): Readonly<Record<string, JsonValue>> => {
  switch (refusal.kind) {
    case "fixed_ceiling": {
      const { ceiling } = refusal;
      return {
        kind: refusal.kind,
        operation: refusal.operation,
        allowance: ceiling.name,
        allowance_kind: ceiling.kind,
        ...(ceiling.limit === undefined ? {} : { limit: ceiling.limit }),
        ...(ceiling.unit === undefined ? {} : { unit: ceiling.unit }),
        ...(ceiling.narrowing === undefined
          ? {}
          : { narrowing: ceiling.narrowing }),
      };
    }
    case "adjustable_budget": {
      const { budget } = refusal;
      return {
        kind: refusal.kind,
        operation: refusal.operation,
        control: budget.parameter ?? budget.setting,
        setting: budget.setting,
        effective_value: budget.effective_value,
        unit: budget.unit,
        range: { minimum: budget.minimum, maximum: budget.maximum },
      };
    }
    case "ambiguous_selector":
      return {
        kind: refusal.kind,
        operation: refusal.operation,
        field: [...refusal.selector.field],
        candidates: [...refusal.selector.candidates],
      };
  }
};
