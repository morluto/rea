import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import {
  DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS,
  MAX_NODE_TIMER_DELAY_MS,
  MINIMUM_HOPPER_CALLER_SCAN_BUDGET_MS,
} from "../domain/analysisResourceLimits.js";
import {
  HOPPER_CALLER_PAGE_ALLOWANCE_BYTES,
  HOPPER_CALLER_SCAN_RETENTION_BYTES,
  type HopperCallerScanFacts,
} from "../domain/native/hopperCallerReconciliation.js";

export const HOPPER_CALLER_SCAN_BUDGET_SETTING =
  "REA_HOPPER_CALLER_SCAN_BUDGET_MS";

/** Effective caller-scan budget and where its milliseconds came from. */
export interface HopperCallerScanBudget {
  readonly setting: typeof HOPPER_CALLER_SCAN_BUDGET_SETTING;
  readonly milliseconds: number;
  readonly source: "default" | "setting" | "runtime";
  readonly defaultMilliseconds: number;
  readonly floorMilliseconds: number;
  readonly maximumMilliseconds: number;
}

export const defaultHopperCallerScanBudget = (): HopperCallerScanBudget => ({
  setting: HOPPER_CALLER_SCAN_BUDGET_SETTING,
  milliseconds: DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS,
  source: "default",
  defaultMilliseconds: DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS,
  floorMilliseconds: MINIMUM_HOPPER_CALLER_SCAN_BUDGET_MS,
  maximumMilliseconds: MAX_NODE_TIMER_DELAY_MS,
});

/** Record whether the launch environment supplied the budget. */
export const hopperCallerScanBudgetFromEnvironment = (
  configured: string | undefined,
  milliseconds: number,
): HopperCallerScanBudget => ({
  ...defaultHopperCallerScanBudget(),
  milliseconds,
  source: configured === undefined ? "default" : "setting",
});

/** Budget record for a caller that already resolved the millisecond count. */
export const hopperCallerScanBudgetForMilliseconds = (
  milliseconds: number,
): HopperCallerScanBudget =>
  hopperCallerScanBudgetFromEnvironment(
    milliseconds === DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS
      ? undefined
      : String(milliseconds),
    milliseconds,
  );

const fixedAllowanceRecovery = `This release has no runtime override for the ${String(HOPPER_CALLER_PAGE_ALLOWANCE_BYTES)} byte instruction, native-caller, and page allowances or the ${String(HOPPER_CALLER_SCAN_RETENTION_BYTES)} byte retention budget. hopper.caller_scan_budget_ms does not raise them.`;

/** Structured facts for the scan time budget. The sentence is display text. */
export const hopperCallerScanLimit = (budget: HopperCallerScanBudget) =>
  analysisSettingLimit(
    "hopper.caller_scan_budget_ms",
    budget.milliseconds,
    budget.source,
  );

/** Environment recovery for a caller-scan limit. Domain facts stay separate. */
export const hopperCallerScanRecovery = (
  facts: HopperCallerScanFacts,
  budget: HopperCallerScanBudget,
): string => {
  const fixedLimit =
    facts.stop.code === "page_allowance" ||
    facts.stop.code === "retention_budget" ||
    !facts.instructions_complete ||
    facts.native_callers_complete === false;
  if (facts.stop.code === "work_budget") {
    const limit = hopperCallerScanLimit(budget);
    return `hopper.caller_scan_budget_ms is ${String(limit.effective_value)} ms (source ${limit.source ?? "unknown"}; default ${String(budget.defaultMilliseconds)} ms, floor ${String(limit.minimum)} ms, maximum ${String(limit.maximum)} ms). It can be changed at runtime with update_analysis_settings. The launch seed is ${budget.setting}. ${fixedAllowanceRecovery}`;
  }
  return fixedLimit ? fixedAllowanceRecovery : "";
};
