import { expect, it } from "vitest";

import { ANALYSIS_SETTINGS } from "../domain/analysisSettingDefinitions.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { validateRegistrationEnvironment } from "../application/RegistrationEnvironmentValidation.js";
import { explicitSetupRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";
import {
  ghidraCheckpointSaveWaitLimit,
  ghidraCheckpointSaveWaitRecovery,
  parseGhidraCheckpointSaveWait,
} from "./ghidraCheckpointSaveWait.js";
import {
  inspectNativeAnalysisConfiguration,
  parseConfig,
} from "./parseConfig.js";

const SETTING = "REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS";

it("waits 30 seconds when the launch environment does not set the control", () => {
  expect(parseGhidraCheckpointSaveWait(undefined)).toEqual({
    ok: true,
    value: { waitMs: 30_000, source: "default" },
  });
  const config = parseConfig({});
  expect(config.ok && config.value.ghidraCheckpointSaveWait).toEqual({
    ok: true,
    value: { waitMs: 30_000, source: "default" },
  });
});

it.each([50, 1_200, 600_000])("admits a launch value of %d ms", (waitMs) => {
  const expected = { ok: true, value: { waitMs, source: "setting" } };
  expect(parseGhidraCheckpointSaveWait(String(waitMs))).toEqual(expected);
  const config = parseConfig({ [SETTING]: String(waitMs) });
  expect(config.ok && config.value.ghidraCheckpointSaveWait).toEqual(expected);
});

it.each([
  ["below the one-poll floor", "49"],
  ["above the ten-minute maximum", "600001"],
  ["far above the maximum", "99999999999999999999"],
  ["zero", "0"],
  ["empty", ""],
  ["negative", "-1"],
  ["leading zero", "0500"],
  ["exponent", "1e4"],
  ["separator", "30_000"],
  ["fraction", "1500.5"],
  ["padded", " 1500"],
  ["unit suffix", "30s"],
])("refuses a value %s without using the default", (_case, raw) => {
  const parsed = parseGhidraCheckpointSaveWait(raw);
  if (parsed.ok) throw new Error(`accepted ${JSON.stringify(raw)}`);
  expect(parsed.error).toBeInstanceOf(ConfigurationError);
  expect(parsed.error.settings).toHaveLength(1);
  expect(parsed.error.settings[0]?.setting).toBe(SETTING);
  expect(parsed.error.settings[0]?.constraint).toContain("from 50 to 600000");
  expect(parsed.error.remediationAction).toContain(
    "environment that starts REA",
  );
  // The rejected text is never echoed.
  if (raw.trim().length > 2)
    expect(parsed.error.settings[0]?.constraint).not.toContain(raw);
});

it("keeps REA starting on an invalid value and reports it to doctor and registration", () => {
  const environment = { [SETTING]: "49" };
  // Other providers and tools are unaffected; the Ghidra session refuses it.
  const config = parseConfig(environment);
  if (!config.ok) throw config.error;
  const wait = config.value.ghidraCheckpointSaveWait;
  expect(wait?.ok).toBe(false);
  expect(inspectNativeAnalysisConfiguration(environment).issues).toEqual([
    expect.objectContaining({ setting: SETTING }),
  ]);
  expect(inspectNativeAnalysisConfiguration({}).issues).toEqual([]);
  const registration = validateRegistrationEnvironment(
    environment,
    new Set(),
    "effective",
    "linux",
  );
  if (registration.ok) throw new Error("registration accepted the value");
  expect(registration.error.settings).toEqual([
    expect.objectContaining({ setting: SETTING }),
  ]);
  // A client expression is not a known value, so it is not judged.
  expect(
    validateRegistrationEnvironment(
      {},
      new Set([SETTING]),
      "effective",
      "linux",
    ).ok,
  ).toBe(true);
});

it("is forwarded by setup when the caller selected it", () => {
  expect(
    explicitSetupRegistrationEnvironment({
      [SETTING]: "45000",
      REA_UNRELATED: "1",
    }),
  ).toEqual({ [SETTING]: "45000" });
});

it("stays a launch-only control outside the runtime setting registry", () => {
  const seeds: (string | undefined)[] = Object.values(ANALYSIS_SETTINGS).map(
    (definition) =>
      "environment" in definition ? definition.environment : undefined,
  );
  expect(seeds).toContain("REA_GHIDRA_STARTUP_TIMEOUT_MS");
  expect(seeds).not.toContain(SETTING);
});

it("reports the control, effective value, source and range of an exhausted wait", () => {
  expect(
    ghidraCheckpointSaveWaitLimit({ waitMs: 1_200, source: "setting" }),
  ).toEqual({
    control_kind: "environment",
    environment: SETTING,
    effective_value: 1_200,
    unit: "ms",
    minimum: 50,
    maximum: 600_000,
    default_value: 30_000,
    applies_at: "next_startup",
  });
  const raised = ghidraCheckpointSaveWaitRecovery({
    waitMs: 1_200,
    source: "setting",
  });
  expect(raised).toContain(`${SETTING} is 1200 ms (source launch environment`);
  expect(raised).toContain("floor 50, maximum 600000");
  expect(raised).toContain("restart REA");
  expect(raised).toContain("update_analysis_settings does not change it");
  // The client's deadline is independent, so a longer wait is no promise.
  expect(raised).toContain(
    "cannot make an MCP client wait longer: that client's own request deadline is separate and unknown to REA",
  );
  const unset = ghidraCheckpointSaveWaitRecovery({
    waitMs: 30_000,
    source: "default",
  });
  expect(unset).toContain(`${SETTING} is 30000 ms (source default`);
  expect(
    ghidraCheckpointSaveWaitRecovery({ waitMs: 600_000, source: "setting" }),
  ).toContain("already at its maximum");
});
