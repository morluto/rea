import { expect, it, vi } from "vitest";

import { HopperProvider } from "../hopper/HopperProvider.js";
import { KunaProvider } from "../kuna/KunaProvider.js";
import { silentLogger } from "../logger.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  MAX_NODE_TIMER_DELAY_MS,
  MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
  MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
} from "../domain/analysisResourceLimits.js";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import {
  regexMatchingDeadlineError,
  regexWorkerHeapError,
} from "../process/RegexMatcher.js";
import { parseConfig } from "./parseConfig.js";
import {
  readRuntimeSetting,
  runtimeAnalysisConfig,
} from "./runtimeAnalysisSettings.js";
import {
  DEFAULT_REGEX_MATCHING_DEADLINE,
  parseRegexMatchingDeadline,
  resolveRegexMatchingDeadline,
  REGEX_MATCHING_DEADLINE_SETTING,
  regexMatchingDeadlineContinuingRecovery,
  regexMatchingDeadlineRecovery,
} from "./regexMatchingDeadline.js";
import {
  DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  parseRegexWorkerHeapRequest,
  resolveRegexWorkerHeapRequest,
  REGEX_WORKER_HEAP_REQUEST_SETTING,
  regexWorkerHeapRequestContinuingRecovery,
} from "./regexWorkerHeapRequest.js";

const deadlines = {
  setting: REGEX_MATCHING_DEADLINE_SETTING,
  minimum: 1,
  maximum: MAX_NODE_TIMER_DELAY_MS,
  defaultBudget: DEFAULT_REGEX_MATCHING_DEADLINE,
  parse: parseRegexMatchingDeadline,
  configured: (deadlineMs: number) => ({ deadlineMs, source: "setting" }),
};
const heaps = {
  setting: REGEX_WORKER_HEAP_REQUEST_SETTING,
  minimum: MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
  maximum: MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
  defaultBudget: DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  parse: parseRegexWorkerHeapRequest,
  configured: (heapMiB: number) => ({ heapMiB, source: "setting" }),
};

it.each([deadlines, heaps])(
  "selects the default and admits both endpoints for $setting",
  ({ minimum, maximum, defaultBudget, parse, configured }) => {
    expect(parse(undefined)).toEqual({ ok: true, value: defaultBudget });
    for (const value of [minimum, maximum]) {
      expect(parse(String(value))).toEqual({
        ok: true,
        value: configured(value),
      });
    }
  },
);

it.each([deadlines, heaps])(
  "refuses malformed decimals and out-of-range values for $setting",
  ({ setting, minimum, maximum, parse }) => {
    for (const raw of [
      "",
      "0",
      "-1",
      "0128",
      "10_000",
      "1e4",
      " 128",
      "128 ",
      "1.5",
      String(minimum - 1),
      String(maximum + 1),
      "9".repeat(40),
    ]) {
      expect(parse(raw), JSON.stringify(raw)).toMatchObject({
        ok: false,
        error: {
          _tag: "ConfigurationError",
          settings: [expect.objectContaining({ setting })],
        },
      });
    }
  },
);

it("uses selected regex budgets for provider capabilities", () => {
  const environment = {
    REA_REGEX_MATCHING_DEADLINE_MS: "10000",
    REA_REGEX_WORKER_HEAP_REQUEST_MIB: "256",
  };
  const parsed = parseConfig(environment);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value).toMatchObject({
    regexMatchingDeadline: deadlines.configured(10_000),
    regexWorkerHeapRequest: heaps.configured(256),
  });

  const conflicting = {
    REA_REGEX_MATCHING_DEADLINE_MS: "1",
    REA_REGEX_WORKER_HEAP_REQUEST_MIB: "8",
  };
  vi.stubEnv(
    REGEX_MATCHING_DEADLINE_SETTING,
    conflicting.REA_REGEX_MATCHING_DEADLINE_MS,
  );
  vi.stubEnv(
    REGEX_WORKER_HEAP_REQUEST_SETTING,
    conflicting.REA_REGEX_WORKER_HEAP_REQUEST_MIB,
  );
  try {
    const providers = [
      new HopperProvider(parsed.value, silentLogger, conflicting),
      new KunaProvider(environment),
    ];
    for (const provider of providers) {
      for (const operation of ["search_procedures", "search_strings"]) {
        const facts = provider
          .capabilities()
          .find((item) => item.operation === operation)
          ?.limitations.join(" ");
        expect(facts).toContain("10000 ms matching deadline (source setting)");
        expect(facts).toContain("256 MiB worker heap request (source setting)");
      }
    }

    const defaults = parseConfig({});
    if (!defaults.ok) throw defaults.error;
    expect(defaults.value).toMatchObject({
      regexMatchingDeadline: DEFAULT_REGEX_MATCHING_DEADLINE,
      regexWorkerHeapRequest: DEFAULT_REGEX_WORKER_HEAP_REQUEST,
    });
    const kunaDefaults = new KunaProvider({})
      .capabilities()
      .find((item) => item.operation === "search_procedures")
      ?.limitations.join(" ");
    expect(kunaDefaults).toContain(
      "5000 ms matching deadline (source default)",
    );
    expect(kunaDefaults).toContain(
      "128 MiB worker heap request (source default)",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  {
    setting: REGEX_MATCHING_DEADLINE_SETTING,
    overrides: { "regex.matching_deadline_ms": 250 },
    readBudget: (config: ReturnType<typeof runtimeAnalysisConfig>) => ({
      deadlineMs: config.regexMatchingDeadline.deadlineMs,
      source: config.regexMatchingDeadline.source,
    }),
    resolve: resolveRegexMatchingDeadline,
    effective: { deadlineMs: 250, source: "runtime" },
  },
  {
    setting: REGEX_WORKER_HEAP_REQUEST_SETTING,
    overrides: { "regex.worker_heap_request_mib": 256 },
    readBudget: (config: ReturnType<typeof runtimeAnalysisConfig>) => ({
      heapMiB: config.regexWorkerHeapRequest.heapMiB,
      source: config.regexWorkerHeapRequest.source,
    }),
    resolve: resolveRegexWorkerHeapRequest,
    effective: { heapMiB: 256, source: "runtime" },
  },
] as const)(
  "defers malformed $setting to the request and honors its override until reset",
  ({ setting, overrides, readBudget, resolve, effective }) => {
    const environment = { [setting]: "invalid" };
    const parsed = parseConfig(environment);
    if (!parsed.ok) throw parsed.error;
    const live = runtimeAnalysisConfig(parsed.value);
    const refused = {
      ok: false,
      error: {
        _tag: "ConfigurationError",
        settings: [expect.objectContaining({ setting })],
      },
    };
    const read = () => readBudget(live);
    expect(readRuntimeSetting(read)).toMatchObject(refused);
    expect(readRuntimeSetting(() => resolve(environment))).toMatchObject(
      refused,
    );
    expect(
      readRuntimeSetting(() => new KunaProvider(environment)),
    ).toMatchObject(refused);
    runWithAnalysisOperationSnapshot({ revision: 1, overrides }, () => {
      expect(read()).toEqual(effective);
      expect(resolve(environment)).toEqual(effective);
    });
    expect(readRuntimeSetting(read)).toMatchObject(refused);
    expect(readRuntimeSetting(() => resolve(environment))).toMatchObject(
      refused,
    );
  },
);

it("projects a CPU deadline separately from worker heap and gives context-specific recovery", () => {
  const deadline = DEFAULT_REGEX_MATCHING_DEADLINE;
  const error = regexMatchingDeadlineError("search_procedures");
  const continuing = projectAnalysisError(error);
  const invocation = projectAnalysisError(error, "invocation");
  expect(continuing).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "cpu",
      limit: {
        setting: "regex.matching_deadline_ms",
        effective_value: deadline.deadlineMs,
        unit: "ms",
        minimum: 1,
        maximum: MAX_NODE_TIMER_DELAY_MS,
        source: "default",
        applies_at: "next_operation",
        agent_editable: true,
        scope: "rea-runtime",
        update_mode: "runtime",
        pending_restart: false,
      },
      reported_limits: {
        matching_deadline_ms: deadline.deadlineMs,
        matching_deadline_source: deadline.source,
      },
    },
  });
  expect(continuing.remediation.action).toContain(
    regexMatchingDeadlineContinuingRecovery(deadline),
  );
  expect(continuing.remediation.action).toContain("update_analysis_settings");
  expect(invocation.remediation.action).toContain(
    regexMatchingDeadlineRecovery(deadline),
  );
  expect(invocation.remediation.action).not.toContain(
    "update_analysis_settings",
  );
});

it("reports effective and requested heap, with next-worker recovery", () => {
  const request = DEFAULT_REGEX_WORKER_HEAP_REQUEST;
  const projected = projectAnalysisError(
    regexWorkerHeapError("search_procedures", new Error("heap"), {
      kind: "effective",
      mib: request.heapMiB,
      overridden: false,
    }),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "memory",
      limit: {
        setting: "regex.worker_heap_request_mib",
        effective_value: request.heapMiB,
        unit: "MiB",
        minimum: MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
        maximum: MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
        source: "default",
        applies_at: "next_worker",
        agent_editable: true,
        scope: "rea-runtime",
        update_mode: "runtime",
        pending_restart: false,
      },
      reported_limits: {
        worker_heap_mib: request.heapMiB,
        requested_worker_heap_mib: request.heapMiB,
        requested_worker_heap_source: request.source,
      },
    },
  });
  expect(projected.remediation.action).toContain(
    regexWorkerHeapRequestContinuingRecovery(request),
  );
  expect(projected.remediation.action).toContain("NODE_OPTIONS");
  expect(projected.remediation.action).toContain("--max-old-space-size");
});
