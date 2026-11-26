import { z } from "zod";

import type { AnalysisParameterLimit } from "./analysisSettings.js";

/**
 * One caller-selected per-call budget: the range its schema accepts, the value
 * used when it is omitted, and its unit. The same object builds the schema and
 * the refusal's `details.limit`, so the reported range is the one the next
 * call accepts.
 */
export interface ParameterBudget {
  readonly minimum: number;
  readonly maximum: number;
  readonly default_value: number;
  readonly unit: AnalysisParameterLimit["unit"];
}

/** The integer schema of a per-call budget, defaulting when omitted. */
export const parameterBudgetSchema = (budget: ParameterBudget) =>
  z
    .number()
    .int()
    .min(budget.minimum)
    .max(budget.maximum)
    .default(budget.default_value);

/**
 * The per-call control that stopped an operation, named by its contract
 * field; each adapter names the option that sets it.
 */
export const parameterBudgetLimit = (
  parameter: string,
  budget: ParameterBudget,
  effectiveValue: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter,
  effective_value: effectiveValue,
  unit: budget.unit,
  minimum: budget.minimum,
  maximum: budget.maximum,
  default_value: budget.default_value,
  applies_at: "next_call",
});
