import { expect, it } from "vitest";
import {
  ghidraDecompileTimeoutRecovery,
  ghidraStartupTimeoutGuidance,
} from "./GhidraProviderClient.js";

it("names the saved Program when a finished invocation must restart after a decompile deadline", () => {
  const recovery = ghidraDecompileTimeoutRecovery(10, "owned-checkpoint");
  expect(recovery.remediationAction).toContain(
    "restores the last saved Program from REA_GHIDRA_CHECKPOINT_DIR",
  );
  expect(recovery.remediationAction).toContain(
    "if initial analysis never completed",
  );
  expect(recovery.remediationAction).not.toContain(
    "repeats import and analysis",
  );
  expect(recovery.continuingRemediationAction).toContain(
    "update_analysis_settings",
  );
});

it("keeps initial analysis and later restore explicit in checkpoint startup recovery", () => {
  const guidance = ghidraStartupTimeoutGuidance(250, "owned-checkpoint");
  expect(guidance.userMessage).toContain(
    "checkpoint restore or initial analysis and saving",
  );
  for (const action of [
    guidance.remediationAction,
    guidance.continuingCallerGuidance.remediationAction,
  ]) {
    expect(action).toContain("Keep REA_GHIDRA_CHECKPOINT_DIR");
    expect(action).toContain(
      "initial analysis and its first checkpoint must complete once",
    );
    expect(action).not.toContain("repeats import from scratch");
    expect(action).not.toContain("REA_GHIDRA_PROJECT_PATH");
  }
});
