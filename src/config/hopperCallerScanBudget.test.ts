import { expect, it } from "vitest";

import { explicitSetupRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";
import {
  DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS,
  MAX_NODE_TIMER_DELAY_MS,
  MINIMUM_HOPPER_CALLER_SCAN_BUDGET_MS,
} from "../domain/analysisResourceLimits.js";
import {
  HOPPER_CALLER_PAGE_ALLOWANCE_BYTES,
  type HopperCallerScanFacts,
} from "../domain/native/hopperCallerReconciliation.js";
import { parseConfig } from "./parseConfig.js";
import { runtimeAnalysisConfig } from "./runtimeAnalysisSettings.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import {
  HOPPER_CALLER_SCAN_BUDGET_SETTING,
  hopperCallerScanRecovery,
} from "./hopperCallerScanBudget.js";

const facts = (
  overrides: Partial<HopperCallerScanFacts> &
    Pick<HopperCallerScanFacts, "stop">,
): HopperCallerScanFacts => ({
  examined_procedures: 1,
  procedure_total: 2,
  retained_bytes: 32,
  instructions_complete: true,
  native_callers_complete: true,
  ...overrides,
});

it("records the default caller-scan budget and forwards an explicit setting", () => {
  const unset = parseConfig({});
  if (!unset.ok) throw unset.error;
  expect(unset.value.hopperCallerScanBudget).toMatchObject({
    milliseconds: DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS,
    source: "default",
    floorMilliseconds: MINIMUM_HOPPER_CALLER_SCAN_BUDGET_MS,
    maximumMilliseconds: MAX_NODE_TIMER_DELAY_MS,
  });
  const selected = parseConfig({
    [HOPPER_CALLER_SCAN_BUDGET_SETTING]: "250",
  });
  if (!selected.ok) throw selected.error;
  expect(selected.value.hopperCallerScanBudget).toMatchObject({
    milliseconds: 250,
    source: "setting",
  });
  expect(
    explicitSetupRegistrationEnvironment({
      [HOPPER_CALLER_SCAN_BUDGET_SETTING]: "250",
      UNRELATED: "dropped",
    }),
  ).toEqual({ [HOPPER_CALLER_SCAN_BUDGET_SETTING]: "250" });
});

it("rejects a malformed caller-scan seed unless an override is active", () => {
  const parsed = parseConfig({ [HOPPER_CALLER_SCAN_BUDGET_SETTING]: "0" });
  if (!parsed.ok) throw new Error("runtime seed rejected startup");
  const live = runtimeAnalysisConfig(parsed.value);
  expect(() => live.hopperCallerScanBudget.milliseconds).toThrow(
    ConfigurationError,
  );
  expect(
    runWithAnalysisOperationSnapshot(
      {
        revision: 1,
        overrides: { "hopper.caller_scan_budget_ms": 250 },
      },
      () => live.hopperCallerScanBudget.milliseconds,
    ),
  ).toBe(250);
});

it("explains the time budget and that fixed byte allowances have no override", () => {
  const parsed = parseConfig({ [HOPPER_CALLER_SCAN_BUDGET_SETTING]: "250" });
  if (!parsed.ok) throw parsed.error;
  const budget = parsed.value.hopperCallerScanBudget;
  const deadline = hopperCallerScanRecovery(
    facts({ stop: { code: "work_budget", budget_ms: 250 } }),
    budget,
  );
  expect(deadline).toContain(
    "hopper.caller_scan_budget_ms is 250 ms (source setting",
  );
  expect(deadline).toContain(
    `floor ${String(MINIMUM_HOPPER_CALLER_SCAN_BUDGET_MS)} ms`,
  );
  expect(deadline).toContain(`maximum ${String(MAX_NODE_TIMER_DELAY_MS)} ms`);
  expect(deadline).toContain("update_analysis_settings");
  expect(deadline).toContain(HOPPER_CALLER_SCAN_BUDGET_SETTING);
  expect(DEFAULT_HOPPER_CALLER_SCAN_BUDGET_MS).toBe(2000);
  const page = hopperCallerScanRecovery(
    facts({
      stop: {
        code: "page_allowance",
        allowance_bytes: HOPPER_CALLER_PAGE_ALLOWANCE_BYTES,
      },
    }),
    budget,
  );
  expect(page).toContain("no runtime override");
  expect(page).toContain("hopper.caller_scan_budget_ms does not raise them");
  expect(page).not.toContain("is 250 ms");
  expect(
    hopperCallerScanRecovery(facts({ stop: { code: "complete" } }), budget),
  ).toBe("");
});
