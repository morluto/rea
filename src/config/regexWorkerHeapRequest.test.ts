import { expect, it, vi } from "vitest";

import { HopperProvider } from "../hopper/HopperProvider.js";
import { KunaProvider } from "../kuna/KunaProvider.js";
import { silentLogger } from "../logger.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { regexWorkerHeapError } from "../process/RegexMatcher.js";
import { parseEnvironment } from "./environment.js";
import { parseConfig } from "./parseConfig.js";
import {
  DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  parseRegexWorkerHeapRequest,
  REGEX_WORKER_HEAP_REQUEST_SETTING,
  regexWorkerHeapRequestRecovery,
} from "./regexWorkerHeapRequest.js";
import {
  MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
  MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
} from "../domain/analysisResourceLimits.js";

const configured = (heapMiB: number) =>
  ({ heapMiB, source: "setting" }) as const;

it("keeps the 128 MiB request when the setting is unset", () => {
  expect(parseRegexWorkerHeapRequest(undefined)).toEqual({
    ok: true,
    value: DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  });
  const parsed = parseConfig({});
  if (!parsed.ok) throw new Error("unset heap request was rejected");
  expect(parsed.value.regexWorkerHeapRequest).toEqual(
    DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  );
  const recovery = regexWorkerHeapRequestRecovery(
    DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  );
  const projected = projectAnalysisError(
    regexWorkerHeapError("search_procedures", new Error("heap"), {
      kind: "effective",
      mib: 128,
      overridden: false,
    }),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "memory",
      limit: {
        setting: "regex.worker_heap_request_mib",
        effective_value: 128,
        unit: "MiB",
        minimum: MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
        maximum: MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
        source: "default",
        applies_at: "next_worker",
        agent_editable: true,
        scope: "rea-runtime",
        rea_restart_required: false,
      },
      reported_limits: {
        requested_worker_heap_mib: DEFAULT_REGEX_WORKER_HEAP_REQUEST.heapMiB,
        requested_worker_heap_source: DEFAULT_REGEX_WORKER_HEAP_REQUEST.source,
      },
    },
  });
  expect(projected.remediation.action).toContain(recovery);
  expect(projected.remediation.action).toContain(
    REGEX_WORKER_HEAP_REQUEST_SETTING,
  );
  expect(projected.remediation.action).toContain("128 MiB");
  expect(projected.remediation.action).toContain("source default");
  expect(projected.remediation.action).toContain("update_analysis_settings");
  expect(projected.remediation.action).toContain(
    "regex.worker_heap_request_mib",
  );
  expect(projected.remediation.action).toContain("--max-old-space-size");
  expect(projected.remediation.action).toContain("NODE_OPTIONS");
  expect(projected.remediation.action).toMatch(/restart REA/i);
  expect(projected.remediation.action).toMatch(/without a REA restart/i);
  expect(projected.remediation.action).toMatch(/overrides this request/i);
});

it("uses a valid REA_REGEX_WORKER_HEAP_REQUEST_MIB override", () => {
  expect(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB).toBe(7);
  expect(
    parseRegexWorkerHeapRequest(String(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)),
  ).toEqual({
    ok: true,
    value: configured(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB),
  });
  expect(parseRegexWorkerHeapRequest("256")).toEqual({
    ok: true,
    value: configured(256),
  });
  expect(
    parseRegexWorkerHeapRequest(String(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)),
  ).toEqual({
    ok: true,
    value: configured(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB),
  });
  const parsed = parseConfig({ REA_REGEX_WORKER_HEAP_REQUEST_MIB: "256" });
  if (!parsed.ok) throw new Error("valid heap request was rejected");
  expect(parsed.value.regexWorkerHeapRequest).toEqual(configured(256));
  const hopper = new HopperProvider(parsed.value, silentLogger, {
    REA_REGEX_WORKER_HEAP_REQUEST_MIB: "8",
  });
  const hopperText = hopper
    .capabilities()
    .find((capability) => capability.operation === "search_procedures")
    ?.limitations.join(" ");
  expect(hopperText).toMatch(/256 MiB worker heap request.*source setting/iu);

  vi.stubEnv(REGEX_WORKER_HEAP_REQUEST_SETTING, "8");
  try {
    const kuna = new KunaProvider({
      REA_REGEX_WORKER_HEAP_REQUEST_MIB: "256",
    });
    const kunaText = kuna
      .capabilities()
      .find((capability) => capability.operation === "search_strings")
      ?.limitations.join(" ");
    expect(kunaText).toMatch(/256 MiB worker heap request.*source setting/iu);
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
    expect.stringMatching(/128 MiB worker heap request.*source default/iu),
  );
});

it.each([
  "",
  "0",
  "6",
  "-1",
  "0128",
  "10_000",
  "1e4",
  " 128",
  "128 ",
  "1.5",
  String(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB + 1),
  "9".repeat(40),
])("rejects invalid %j as a configuration error", (value) => {
  const parsed = parseRegexWorkerHeapRequest(value);
  if (parsed.ok) throw new Error(`Accepted ${JSON.stringify(value)}`);
  expect(parsed.error).toBeInstanceOf(ConfigurationError);
  expect(parsed.error.message).toContain(REGEX_WORKER_HEAP_REQUEST_SETTING);
  expect(parsed.error.message).toMatch(/decimal integer/i);
  expect(parsed.error.message).toMatch(/7 to 16384 MiB/i);
  expect(parsed.error.message).toMatch(/default.*128 MiB/i);
  expect(parsed.error.message).toMatch(/abort.*worker.*startup/i);
  expect(parsed.error.settings).toEqual([
    {
      setting: "REA_REGEX_WORKER_HEAP_REQUEST_MIB",
      constraint: parsed.error.message,
    },
  ]);
  const startup = parseEnvironment({
    REA_REGEX_WORKER_HEAP_REQUEST_MIB: value,
  });
  if (startup.ok) throw new Error(`Startup accepted ${JSON.stringify(value)}`);
  expect(startup.error.settings).toContainEqual({
    setting: REGEX_WORKER_HEAP_REQUEST_SETTING,
    constraint: parsed.error.message,
  });
  const config = parseConfig({ REA_REGEX_WORKER_HEAP_REQUEST_MIB: value });
  if (config.ok)
    throw new Error(`parseConfig accepted ${JSON.stringify(value)}`);
  expect(projectAnalysisError(config.error)).toMatchObject({
    code: "configuration_invalid",
    message: expect.stringContaining("REA_REGEX_WORKER_HEAP_REQUEST_MIB"),
  });
  expect(
    () => new KunaProvider({ REA_REGEX_WORKER_HEAP_REQUEST_MIB: value }),
  ).toThrow(ConfigurationError);
});
