import { expect, it } from "vitest";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import { parseEnvironment } from "./environment.js";
import {
  WINDOWS_CHANGE_TIME_DRIFT_MS,
  WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS,
  WINDOWS_CHANGE_TIME_SETTLE_POLL_MS,
  applyWindowsChangeTimeSnapshot,
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
  expect(startup.ok).toBe(true);
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
  expect(startup.ok).toBe(true);
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
    update_mode: "runtime" as const,
  };
  expect(resolved.error.settings).toEqual([facts]);
  expect(resolved.error.settings[0]).not.toHaveProperty("pending_restart");
  expect(message).toContain("supplied");
  expect(projectAnalysisError(resolved.error)).toMatchObject({
    code: "configuration_invalid",
    details: { settings: [facts] },
  });
  const startup = parseEnvironment({ [bound.setting]: value });
  if (!startup.ok)
    throw new Error(`Startup rejected runtime seed ${bound.setting}`);
});

it("applies a Windows settle override before rejecting the launch value", () => {
  const limits = runWithAnalysisOperationSnapshot(
    {
      revision: 1,
      overrides: {
        "windows.change_time_drift_ms": 50,
        "windows.change_time_settle_poll_ms": 10,
        "windows.change_time_settle_max_polls": 4,
      },
    },
    () => {
      const resolved = resolveWindowsChangeTimeSettle({
        REA_WINDOWS_CHANGE_TIME_DRIFT_MS: "nope",
        REA_WINDOWS_CHANGE_TIME_SETTLE_POLL_MS: "0",
        REA_WINDOWS_CHANGE_TIME_SETTLE_MAX_POLLS: "1001",
      });
      if (!resolved.ok) throw resolved.error;
      return applyWindowsChangeTimeSnapshot(resolved.value);
    },
  );
  expect(limits).toMatchObject({
    driftMs: 50,
    driftSource: "runtime",
    pollMs: 10,
    pollSource: "runtime",
    maxPolls: 4,
    maxPollsSource: "runtime",
  });
});
