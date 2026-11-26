import type { AnalysisCallerLifetime } from "./analysisErrorBase.js";
import type {
  AnalysisParameterLimit,
  AnalysisSettingLimit,
} from "./analysisSettings.js";
import { z } from "zod";
import {
  analysisSettingDefinition,
  analysisSettingIdSchema,
} from "./analysisSettingDefinitions.js";
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

const budgetControl = (budget: AdjustableBudget): string =>
  "control_kind" in budget
    ? budget.parameter
    : (budget.parameter ?? budget.setting);

/**
 * The `details.refusal` facts of an adjustable budget. They are complete for
 * its recovery, so an adapter parses them and renders its own spelling
 * instead of reading the sentence. `control` differs from `setting` when a
 * per-call parameter selects the value; `setting` is absent for a per-call
 * control no registered setting backs.
 */
export const adjustableBudgetRefusalSchema = z.strictObject({
  kind: z.literal("adjustable_budget"),
  operation: z.string(),
  control: z.string(),
  setting: analysisSettingIdSchema.exactOptional(),
  source: z.enum(["default", "setting", "runtime", "request"]).exactOptional(),
  effective_value: z.number().nullable(),
  unit: z.enum(["bytes", "ms", "seconds", "MiB", "count"]),
  range: z.strictObject({ minimum: z.number(), maximum: z.number() }),
  default_value: z.number().exactOptional(),
  required_value: z.number().exactOptional(),
});
export type AdjustableBudgetRefusal = z.output<
  typeof adjustableBudgetRefusalSchema
>;

const adjustableBudgetFacts = (
  operation: string,
  budget: AdjustableBudget,
): AdjustableBudgetRefusal => ({
  kind: "adjustable_budget",
  operation,
  control: budgetControl(budget),
  ...("control_kind" in budget
    ? {}
    : {
        setting: budget.setting,
        ...(budget.source === undefined ? {} : { source: budget.source }),
      }),
  effective_value: budget.effective_value,
  unit: budget.unit,
  range: { minimum: budget.minimum, maximum: budget.maximum },
  ...("default_value" in budget ? { default_value: budget.default_value } : {}),
  ...(budget.required_value === undefined
    ? {}
    : { required_value: budget.required_value }),
});

/**
 * The ways to raise a registered setting for the caller's lifetime: the
 * runtime override for a continuing caller, else the environment seed a new
 * invocation or REA start reads. `alone` is the recovery when it is the only
 * route; `after` follows a per-call step. Undefined when a one-invocation
 * caller has no environment seed to set.
 */
const settingRoute = (
  setting: AnalysisSettingLimit["setting"],
  callerLifetime: AnalysisCallerLifetime,
): { readonly alone: string; readonly after: string } | undefined => {
  const { environment, updateMode } = analysisSettingDefinition(setting);
  if (callerLifetime === "invocation")
    return environment === undefined
      ? undefined
      : {
          alone: `Set ${environment} for the next invocation`,
          after: `To raise it for later invocations, set ${environment} in the environment that starts them.`,
        };
  if (updateMode === "runtime")
    return {
      alone: `Raise ${setting} with update_analysis_settings`,
      after: `To raise it for this session, set ${setting} with update_analysis_settings.`,
    };
  const seed = environment ?? setting;
  return {
    alone: `Set ${seed} in the environment that starts REA, then restart REA`,
    after: `To raise it for later calls, set ${seed} in the environment that starts REA, then restart REA.`,
  };
};

/** A budget quantity as prose; a count needs no unit word. */
const quantity = (
  value: number | string,
  unit: AdjustableBudgetRefusal["unit"],
): string => (unit === "count" ? String(value) : `${String(value)} ${unit}`);

/**
 * The recovery of an adjustable budget, from its refusal facts alone. A
 * per-call control gets the next-call step; one a registered setting backs
 * also gets the setting route for the caller's lifetime, for repeated work.
 */
export const adjustableBudgetRemediation = (
  facts: AdjustableBudgetRefusal,
  callerLifetime: AnalysisCallerLifetime,
  spelling: PerCallControlSpelling = MCP_PER_CALL_CONTROL_SPELLING,
): string => {
  const {
    operation,
    control,
    setting,
    source,
    unit,
    range: { minimum, maximum },
    effective_value: value,
    required_value: required,
  } = facts;
  const range = quantity(`${String(minimum)}..${String(maximum)}`, unit);
  const effective =
    value === null
      ? `The effective ${control} value is unknown`
      : `${operation} reached its ${control} budget of ${quantity(value, unit)}${source === undefined ? "" : ` (source ${source})`}`;
  if (value !== null && value >= maximum)
    return `${effective}. ${control} is already at its maximum (${range}); narrow the request or select a smaller input. ${UNCHANGED}`;
  if (required !== undefined && required > maximum)
    return `${effective}. The request requires ${quantity(required, unit)}, above the ${control} maximum (${range}); narrow the request or select a smaller input. ${UNCHANGED}`;
  const atLeast =
    required === undefined ? "" : `at least ${quantity(required, unit)}; `;
  const bounds = `(${atLeast}range ${range}), then retry.`;
  const route =
    setting === undefined ? undefined : settingRoute(setting, callerLifetime);
  if (setting !== undefined && control === setting)
    return `${effective}. ${route?.alone ?? `Set ${setting} for the next invocation`} ${bounds}`;
  const perCall = `${effective}. Pass a larger ${spelling.parameter(control)} on ${spelling.call(operation)} ${bounds}`;
  return route === undefined ? perCall : `${perCall} ${route.after}`;
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
        adjustableBudgetFacts(refusal.operation, refusal.budget),
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
    case "adjustable_budget":
      return adjustableBudgetFacts(refusal.operation, refusal.budget);
    case "ambiguous_selector":
      return {
        kind: refusal.kind,
        operation: refusal.operation,
        field: [...refusal.selector.field],
        candidates: [...refusal.selector.candidates],
      };
  }
};
