import { expect, it } from "vitest";

import { ANALYSIS_SETTINGS } from "../domain/analysisSettingDefinitions.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { validateRegistrationEnvironment } from "../application/RegistrationEnvironmentValidation.js";
import { explicitSetupRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";
import {
  ghidraCancelGraceFacts,
  parseGhidraCancelGrace,
} from "./ghidraCancelGrace.js";
import {
  inspectNativeAnalysisConfiguration,
  parseConfig,
} from "./parseConfig.js";

const SETTING = "REA_GHIDRA_CANCEL_GRACE_MS";

it("allows two seconds when the launch environment does not set the control", () => {
  const expected = { ok: true, value: { graceMs: 2_000, source: "default" } };
  expect(parseGhidraCancelGrace(undefined)).toEqual(expected);
  const config = parseConfig({});
  expect(config.ok && config.value.ghidraCancelGrace).toEqual(expected);
});

it.each([100, 750, 60_000])("admits a launch value of %d ms", (graceMs) => {
  const expected = { ok: true, value: { graceMs, source: "setting" } };
  expect(parseGhidraCancelGrace(String(graceMs))).toEqual(expected);
  const config = parseConfig({ [SETTING]: String(graceMs) });
  expect(config.ok && config.value.ghidraCancelGrace).toEqual(expected);
});

it.each([
  ["below the floor", "99"],
  ["above the one-minute maximum", "60001"],
  ["far above the maximum", "99999999999999999999"],
  ["zero", "0"],
  ["empty", ""],
  ["negative", "-1"],
  ["leading zero", "0500"],
  ["exponent", "1e3"],
  ["separator", "2_000"],
  ["fraction", "1500.5"],
  ["padded", " 1500"],
  ["unit suffix", "2s"],
])("refuses a value %s without using the default", (_case, raw) => {
  const parsed = parseGhidraCancelGrace(raw);
  if (parsed.ok) throw new Error(`accepted ${JSON.stringify(raw)}`);
  expect(parsed.error).toBeInstanceOf(ConfigurationError);
  expect(parsed.error.settings).toHaveLength(1);
  expect(parsed.error.settings[0]?.setting).toBe(SETTING);
  expect(parsed.error.settings[0]?.constraint).toContain("from 100 to 60000");
  expect(parsed.error.remediationAction).toContain(
    "environment that starts REA",
  );
  // The rejected text is never echoed.
  if (raw.trim().length > 2)
    expect(parsed.error.settings[0]?.constraint).not.toContain(raw);
});

it("keeps REA starting on an invalid value and reports it to doctor and registration", () => {
  const environment = { [SETTING]: "99" };
  // Other providers and tools are unaffected; a Ghidra session refuses it.
  const config = parseConfig(environment);
  if (!config.ok) throw config.error;
  expect(config.value.ghidraCancelGrace?.ok).toBe(false);
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
      [SETTING]: "750",
      REA_UNRELATED: "1",
    }),
  ).toEqual({ [SETTING]: "750" });
});

it("stays a launch-only control outside the runtime setting registry", () => {
  const seeds: (string | undefined)[] = Object.values(ANALYSIS_SETTINGS).map(
    (definition) =>
      "environment" in definition ? definition.environment : undefined,
  );
  expect(seeds).toContain("REA_GHIDRA_STARTUP_TIMEOUT_MS");
  expect(seeds).not.toContain(SETTING);
});

it("states the control, effective value, source and range", () => {
  expect(ghidraCancelGraceFacts({ graceMs: 750, source: "setting" })).toBe(
    `${SETTING} is 750 ms (source launch environment; default 2000, floor 100, maximum 60000)`,
  );
  expect(ghidraCancelGraceFacts({ graceMs: 2_000, source: "default" })).toBe(
    `${SETTING} is 2000 ms (source default; default 2000, floor 100, maximum 60000)`,
  );
});
