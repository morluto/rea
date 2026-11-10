import { expect, it, vi } from "vitest";

import { HopperProvider } from "../hopper/HopperProvider.js";
import { KunaProvider } from "../kuna/KunaProvider.js";
import { silentLogger } from "../logger.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { regexMatchingDeadlineError } from "../process/RegexMatcher.js";
import { parseEnvironment } from "./environment.js";
import { parseConfig } from "./parseConfig.js";
import {
  DEFAULT_REGEX_MATCHING_DEADLINE,
  parseRegexMatchingDeadline,
  REGEX_MATCHING_DEADLINE_SETTING,
  regexMatchingDeadlineRecovery,
} from "./regexMatchingDeadline.js";
import { MAXIMUM_REGEX_MATCHING_DEADLINE_MS } from "../domain/analysisResourceLimits.js";

const configured = (deadlineMs: number) =>
  ({ deadlineMs, source: "setting" }) as const;

it("keeps the 5000 ms deadline when the setting is unset", () => {
  expect(parseRegexMatchingDeadline(undefined)).toEqual({
    ok: true,
    value: DEFAULT_REGEX_MATCHING_DEADLINE,
  });
  const parsed = parseConfig({});
  if (!parsed.ok) throw new Error("unset deadline was rejected");
  expect(parsed.value.regexMatchingDeadline).toEqual(
    DEFAULT_REGEX_MATCHING_DEADLINE,
  );
  const recovery = regexMatchingDeadlineRecovery(
    DEFAULT_REGEX_MATCHING_DEADLINE,
  );
  const projected = projectAnalysisError(
    regexMatchingDeadlineError("search_procedures"),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "cpu",
      limit: {
        setting: "regex.matching_deadline_ms",
        effective_value: 5000,
        unit: "ms",
        minimum: 1,
        maximum: MAXIMUM_REGEX_MATCHING_DEADLINE_MS,
        source: "default",
        applies_at: "next_operation",
        agent_editable: true,
        scope: "rea-runtime",
        rea_restart_required: false,
      },
      reported_limits: {
        matching_deadline_ms: DEFAULT_REGEX_MATCHING_DEADLINE.deadlineMs,
        matching_deadline_source: DEFAULT_REGEX_MATCHING_DEADLINE.source,
      },
    },
  });
  expect(projected.remediation.action).toContain(recovery);
  expect(projected.remediation.action).toContain(
    REGEX_MATCHING_DEADLINE_SETTING,
  );
  expect(projected.remediation.action).toContain("5000 ms");
  expect(projected.remediation.action).toContain("source default");
  expect(projected.remediation.action).toContain("update_analysis_settings");
  expect(projected.remediation.action).toContain("regex.matching_deadline_ms");
  expect(projected.remediation.action).toMatch(/restart REA/i);
  expect(projected.remediation.action).toMatch(/without a REA restart/i);
  expect(projected.remediation.action).toMatch(
    /heap does not raise this deadline/i,
  );
});

it("uses a valid REA_REGEX_MATCHING_DEADLINE_MS override", () => {
  expect(parseRegexMatchingDeadline("10000")).toEqual({
    ok: true,
    value: configured(10_000),
  });
  expect(
    parseRegexMatchingDeadline(String(MAXIMUM_REGEX_MATCHING_DEADLINE_MS)),
  ).toEqual({
    ok: true,
    value: configured(MAXIMUM_REGEX_MATCHING_DEADLINE_MS),
  });
  const parsed = parseConfig({ REA_REGEX_MATCHING_DEADLINE_MS: "10000" });
  if (!parsed.ok) throw new Error("valid deadline was rejected");
  expect(parsed.value.regexMatchingDeadline).toEqual(configured(10_000));
  const hopper = new HopperProvider(parsed.value, silentLogger, {
    REA_REGEX_MATCHING_DEADLINE_MS: "1",
  });
  const hopperText = hopper
    .capabilities()
    .find((capability) => capability.operation === "search_procedures")
    ?.limitations.join(" ");
  expect(hopperText).toMatch(/10000 ms matching deadline.*source setting/iu);

  vi.stubEnv(REGEX_MATCHING_DEADLINE_SETTING, "1");
  try {
    const kuna = new KunaProvider({ REA_REGEX_MATCHING_DEADLINE_MS: "10000" });
    const kunaText = kuna
      .capabilities()
      .find((capability) => capability.operation === "search_strings")
      ?.limitations.join(" ");
    expect(kunaText).toMatch(/10000 ms matching deadline.*source setting/iu);
  } finally {
    vi.unstubAllEnvs();
  }

  const ambient = new KunaProvider({});
  expect(
    ambient
      .capabilities()
      .find((capability) => capability.operation === "search_procedures")
      ?.limitations,
  ).toContainEqual(
    expect.stringMatching(/5000 ms matching deadline.*source default/iu),
  );
});

it.each([
  "",
  "0",
  "-1",
  "05000",
  "10_000",
  "1e4",
  " 5000",
  "5000 ",
  "1.5",
  String(MAXIMUM_REGEX_MATCHING_DEADLINE_MS + 1),
  "9".repeat(40),
])("rejects invalid %j as a configuration error", (value) => {
  const parsed = parseRegexMatchingDeadline(value);
  if (parsed.ok) throw new Error(`Accepted ${JSON.stringify(value)}`);
  expect(parsed.error).toBeInstanceOf(ConfigurationError);
  expect(parsed.error.message).toContain(REGEX_MATCHING_DEADLINE_SETTING);
  expect(parsed.error.message).toMatch(/positive decimal integer/i);
  expect(parsed.error.message).toMatch(/1 to 2147483647 ms/i);
  expect(parsed.error.message).toMatch(/default.*5000 ms/i);
  expect(parsed.error.message).toMatch(/Node.*1 ms/i);
  expect(parsed.error.settings).toEqual([
    {
      setting: "REA_REGEX_MATCHING_DEADLINE_MS",
      constraint: parsed.error.message,
    },
  ]);
  const startup = parseEnvironment({ REA_REGEX_MATCHING_DEADLINE_MS: value });
  if (startup.ok) throw new Error(`Startup accepted ${JSON.stringify(value)}`);
  expect(startup.error.settings).toContainEqual({
    setting: REGEX_MATCHING_DEADLINE_SETTING,
    constraint: parsed.error.message,
  });
  const config = parseConfig({ REA_REGEX_MATCHING_DEADLINE_MS: value });
  if (config.ok)
    throw new Error(`parseConfig accepted ${JSON.stringify(value)}`);
  expect(projectAnalysisError(config.error)).toMatchObject({
    code: "configuration_invalid",
    message: expect.stringContaining("REA_REGEX_MATCHING_DEADLINE_MS"),
  });
  expect(
    () => new KunaProvider({ REA_REGEX_MATCHING_DEADLINE_MS: value }),
  ).toThrow(ConfigurationError);
});
