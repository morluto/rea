import type { AnalysisCallerLifetime } from "./analysisErrorBase.js";
import type {
  AnalysisParameterLimit,
  AnalysisSettingLimit,
} from "./analysisSettings.js";
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
 * - `adjustable_budget`: an agent-adjustable setting (`AnalysisSettingLimit`)
 *   or per-call parameter (`AnalysisParameterLimit`) with its control, unit,
 *   range and, when the producer measured it, the minimum value
 *   (`required_value`) that admits the request.
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
      readonly budget: AdjustableBudget;
    }
  | {
      readonly kind: "ambiguous_selector";
      readonly operation: string;
      readonly selector: AmbiguousSelector;
    };

/** A budget the caller can raise: a registered setting or a per-call parameter. */
export type AdjustableBudget = AnalysisSettingLimit | AnalysisParameterLimit;

const fieldName = (field: RefusalField): string => field.map(String).join(".");

const UNCHANGED = "Repeating the unchanged request is not expected to succeed.";

/** How an adapter spells a per-call control and the call that accepts it. */
export interface PerCallControlSpelling {
  readonly parameter: (parameter: string) => string;
  readonly call: (operation: string) => string;
}

/** MCP names a control by its contract field and the call by its tool. */
export const MCP_PER_CALL_CONTROL_SPELLING: PerCallControlSpelling = {
  parameter: (parameter) => parameter,
  call: (operation) => `the next ${operation} call`,
};

/**
 * The step that raises a per-call control. Adapters re-render it with their
 * own spelling, so it is the one sentence fragment they replace.
 */
export const perCallControlChange = (
  parameter: string,
  operation: string,
  spelling: PerCallControlSpelling = MCP_PER_CALL_CONTROL_SPELLING,
): string =>
  `Pass a larger ${spelling.parameter(parameter)} on ${spelling.call(operation)}`;

const budgetControl = (budget: AdjustableBudget): string =>
  "control_kind" in budget
    ? budget.parameter
    : (budget.parameter ?? budget.setting);

const settingBudgetChange = (
  operation: string,
  budget: AnalysisSettingLimit,
  callerLifetime: AnalysisCallerLifetime,
): string => {
  const environment = analysisSettingDefinition(budget.setting).environment;
  if (
    budget.parameter !== undefined &&
    (budget.update_mode === "parameter" ||
      (callerLifetime === "invocation" && environment === undefined))
  )
    return perCallControlChange(budget.parameter, operation);
  if (callerLifetime === "invocation")
    return `Set ${environment ?? budget.setting} for the next invocation`;
  return budget.update_mode === "runtime"
    ? `Raise ${budget.setting} with update_analysis_settings`
    : `Set ${environment ?? budget.setting} in the environment that starts REA, then restart REA`;
};

/** A budget quantity as prose; a count needs no unit word. */
const quantity = (
  value: number | string,
  unit: AdjustableBudget["unit"],
): string => (unit === "count" ? String(value) : `${String(value)} ${unit}`);

const adjustableBudgetRemediation = (
  operation: string,
  budget: AdjustableBudget,
  callerLifetime: AnalysisCallerLifetime,
): string => {
  const {
    unit,
    minimum,
    maximum,
    effective_value: value,
    required_value: required,
  } = budget;
  const control = budgetControl(budget);
  const source = "control_kind" in budget ? undefined : budget.source;
  const range = quantity(`${String(minimum)}..${String(maximum)}`, unit);
  const effective =
    value === null
      ? `The effective ${control} value is unknown`
      : `${operation} reached its ${control} budget of ${quantity(value, unit)}${source === undefined ? "" : ` (source ${source})`}`;
  if (value !== null && value >= maximum)
    return `${effective}. ${control} is already at its maximum (${range}); narrow the request or select a smaller input. ${UNCHANGED}`;
  if (required !== undefined && required > maximum)
    return `${effective}. The request requires ${quantity(required, unit)}, above the ${control} maximum (${range}); narrow the request or select a smaller input. ${UNCHANGED}`;
  const change =
    "control_kind" in budget
      ? perCallControlChange(budget.parameter, operation)
      : settingBudgetChange(operation, budget, callerLifetime);
  const atLeast =
    required === undefined ? "" : `at least ${quantity(required, unit)}; `;
  return `${effective}. ${change} (${atLeast}range ${range}), then retry.`;
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
      const value =
        ceiling.limit === undefined || ceiling.unit === undefined
          ? ""
          : ` The allowance is ${String(ceiling.limit)} ${ceiling.unit}; this release has no runtime override.`;
      return ceiling.narrowing === undefined
        ? `${base}${value}`
        : `${base}${value} ${ceiling.narrowing}`;
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
        control: budgetControl(budget),
        ...("control_kind" in budget ? {} : { setting: budget.setting }),
        effective_value: budget.effective_value,
        unit: budget.unit,
        range: { minimum: budget.minimum, maximum: budget.maximum },
        ...("default_value" in budget
          ? { default_value: budget.default_value }
          : {}),
        ...(budget.required_value === undefined
          ? {}
          : { required_value: budget.required_value }),
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
