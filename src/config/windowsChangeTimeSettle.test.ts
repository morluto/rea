import { expect, it } from "vitest";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { parseEnvironment } from "./environment.js";
import {
  WINDOWS_CHANGE_TIME_DRIFT_MS,
  WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
  WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
  resolveWindowsChangeTimeSettle,
} from "./windowsChangeTimeSettle.js";

const requiredFacts = (
  message: string,
  fact: {
    readonly setting: string;
    readonly currentValue: string;
    readonly source: string;
    readonly defaultValue: number;
    readonly floor: number;
    readonly maximum: number;
  },
): void => {
  expect(message).toContain(fact.setting);
  expect(message).toContain(fact.currentValue);
  expect(message).toContain(`source ${fact.source}`);
  expect(message).toContain(String(fact.defaultValue));
  expect(message).toContain(String(fact.floor));
  expect(message).toContain(String(fact.maximum));
  expect(message).toContain("positive decimal integer");
};

it("keeps today's settle defaults when the settings are unset", () => {
  expect(resolveWindowsChangeTimeSettle({})).toEqual({
    ok: true,
    value: {
      driftMs: 2_000,
      driftSource: "default",
      pollMs: 25,
      pollSource: "default",
      maxPolls: 40,
      maxPollsSource: "default",
    },
  });
  const startup = parseEnvironment({});
  if (!startup.ok) throw new Error("unset settle settings were rejected");
  expect(startup.value.REA_WINDOWS_CHANGE_TIME_DRIFT_MS).toBeUndefined();
  expect(startup.value.REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS).toBeUndefined();
  expect(
    startup.value.REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
  ).toBeUndefined();
});

it("uses valid settle overrides", () => {
  expect(
    resolveWindowsChangeTimeSettle({
      REA_WINDOWS_CHANGE_TIME_DRIFT_MS: "60",
      REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS: "1000",
      REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS: "1",
    }),
  ).toEqual({
    ok: true,
    value: {
      driftMs: 60,
      driftSource: "setting",
      pollMs: 1_000,
      pollSource: "setting",
      maxPolls: 1,
      maxPollsSource: "setting",
    },
  });
  const startup = parseEnvironment({
    REA_WINDOWS_CHANGE_TIME_DRIFT_MS: "60000",
    REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS: "1",
    REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS: "1000",
  });
  if (!startup.ok) throw new Error("valid settle settings were rejected");
  expect(startup.value.REA_WINDOWS_CHANGE_TIME_DRIFT_MS).toBe(60_000);
  expect(startup.value.REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS).toBe(1);
  expect(startup.value.REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS).toBe(1_000);
});

it.each([
  [WINDOWS_CHANGE_TIME_DRIFT_MS, "0"],
  [WINDOWS_CHANGE_TIME_DRIFT_MS, "60001"],
  [WINDOWS_CHANGE_TIME_DRIFT_MS, "1e3"],
  [WINDOWS_CHANGE_TIME_DRIFT_MS, "0x10"],
  [WINDOWS_CHANGE_TIME_DRIFT_MS, ""],
  [WINDOWS_CHANGE_TIME_DRIFT_MS, "02000"],
  [WINDOWS_CHANGE_TIME_SETTLE_POLL_MS, "0"],
  [WINDOWS_CHANGE_TIME_SETTLE_POLL_MS, "1001"],
  [WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS, "0"],
  [WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS, "1001"],
] as const)("rejects %s=%j", (bound, value) => {
  const resolved = resolveWindowsChangeTimeSettle({ [bound.setting]: value });
  if (resolved.ok) throw new Error(`Accepted ${bound.setting}=${value}`);
  expect(resolved.error).toBeInstanceOf(ConfigurationError);
  const message = resolved.error.settings[0]?.constraint;
  if (message === undefined) throw new Error("Missing configuration guidance");
  requiredFacts(message, { ...bound, currentValue: value, source: "setting" });
  const facts = {
    setting: bound.setting,
    constraint: message,
    update_mode: "restart" as const,
    pending_restart: true as const,
  };
  expect(resolved.error.settings).toEqual([facts]);
  expect(projectAnalysisError(resolved.error)).toMatchObject({
    code: "configuration_invalid",
    details: { settings: [facts] },
  });
  const startup = parseEnvironment({ [bound.setting]: value });
  if (startup.ok) throw new Error(`Startup accepted ${bound.setting}=${value}`);
  expect(startup.error.settings).toContainEqual(facts);
  expect(projectAnalysisError(startup.error).details).toMatchObject({
    settings: [facts],
  });
});
