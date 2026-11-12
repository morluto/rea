import { resolveScenarioSecrets } from "../../tests/fixtures/browserScenarioSecrets.js";
import { expect, it } from "vitest";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { resolvedAnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { parseEvidence } from "../domain/evidence.js";
import { browserScenarioInputSchema } from "../domain/browserScenario.js";
import type {
  BrowserScenarioCapture,
  BrowserScenarioPartialObservation,
} from "../domain/browserScenarioCapture.js";
import { err, ok } from "../domain/result.js";
import { scriptScenarioFixture } from "../../tests/fixtures/webScriptCapture.js";
import type { BrowserScenarioCapturePort } from "./BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "./BrowserScenarioCaptureService.js";
import {
  expectDroppedPartial,
  expectKeptPartial,
  expectOwnerError,
} from "../../tests/fixtures/ownerObservationExpectation.js";

const scenario = browserScenarioInputSchema.parse({
  browser: { mode: "launch", executable_path: "/fixture/chrome" },
  start_url: { url: "https://fixture.test/", query: [] },
  actions: [{ step_id: "settle", action: "wait_for_timeout", duration_ms: 1 }],
});
const capture = scriptScenarioFixture();
const scenarioIdentity = {
  id: "scenario-fixture",
  name: "Scenario fixture",
  version: "1",
};
const runScenario = (
  failure: AnalysisError,
  id = { id: "fixture", name: "fixture", version: "1" },
) =>
  captureBrowserScenario(
    {
      identity: () => id,
      captureScenario: async () => err(failure),
    },
    scenario,
  );
const expectRetainedCapture = (
  result: Awaited<ReturnType<typeof runScenario>>,
  failure: AnalysisError,
) => {
  if (result.ok) throw new Error("Expected the retained capture");
  expect(result.error).toBe(failure);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "capture_browser_scenario",
    normalized_result: capture,
  });
};

it("converts a retained raw scenario capture into partial Evidence", async () => {
  const failure = new AnalysisCancelledError("capture_browser_scenario", {
    partialObservation: {
      kind: "browser-scenario-observation",
      capture,
    },
  });
  expectRetainedCapture(await runScenario(failure, scenarioIdentity), failure);
});

it("converts a raw scenario capture retained after cleanup failure", async () => {
  const failure = new BrowserObservationError(
    "capture_browser_scenario",
    "cleanup_failed",
    {
      cleanup: {
        reason: "browser close failed",
        resources: ["browser process"],
      },
      partialObservation: {
        kind: "browser-scenario-observation",
        capture,
      },
    },
  );
  const result = await runScenario(failure, scenarioIdentity);
  expectRetainedCapture(result, failure);
  if (!result.ok) expect(result.error.cleanupIncomplete).toBe(true);
});

it.each([false, true])(
  "retains completed scenario Evidence after cleanup resolves (wrapper facts: %s)",
  async (wrapperFacts) => {
    const partial = { kind: "browser-scenario-observation" as const, capture };
    const primary = new AnalysisCancelledError("capture_browser_scenario", {
      partialObservation: partial,
    });
    const failure = new BrowserObservationError(
      "capture_browser_scenario",
      "cleanup_failed",
      {
        cleanupPrimary: primary,
        cleanup: {
          reason: "browser close failed",
          resources: ["browser process"],
        },
        ...(wrapperFacts ? { partialObservation: partial } : {}),
      },
    );
    const result = await runScenario(failure, scenarioIdentity);
    if (result.ok) throw new Error("Expected cleanup failure");
    expect(result.error).toBe(failure);
    failure.resolveCleanup();
    expect(resolvedAnalysisError(failure)).toBe(primary);
    expect(parseEvidence(primary.partialObservation)).toMatchObject({
      operation: "capture_browser_scenario",
      normalized_result: capture,
    });
    if (wrapperFacts)
      expect(failure.partialObservation).toBe(primary.partialObservation);
  },
);

it.each([
  null,
  { request: "opaque cancellation" },
  new BrowserObservationError("capture_browser_scenario", "protocol_error"),
])(
  "preserves the exact pre-admission caller reason without dispatch: %j",
  async (reason) => {
    const caller = new AbortController();
    caller.abort(reason);
    let calls = 0;
    const provider: BrowserScenarioCapturePort = {
      identity: () => ({ id: "fixture", name: "fixture", version: "1" }),
      captureScenario: async () => {
        calls++;
        throw new Error("Unexpected dispatch");
      },
    };
    const result = await captureBrowserScenario(provider, scenario, {
      signal: caller.signal,
    });
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(calls).toBe(0);
  },
);

it("retains completed scenario Evidence when cancellation arrives during capture", async () => {
  const caller = new AbortController();
  const reason = { requested: "stop after capture" };
  const provider: BrowserScenarioCapturePort = {
    identity: () => scenarioIdentity,
    captureScenario: async (received, options) => {
      expect(received).toBe(scenario);
      expect(options?.signal).toBe(caller.signal);
      caller.abort(reason);
      return ok(capture);
    },
  };
  const result = await captureBrowserScenario(provider, scenario, {
    signal: caller.signal,
  });
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "capture_browser_scenario",
    provider: scenarioIdentity,
    confidence: "observed",
    authority: "controlled-replay",
    parameters: {
      browser: scenario.browser,
      start_url: scenario.start_url,
      actions: scenario.actions,
    },
    normalized_result: capture,
  });
});

it("keeps startup cancellation and its incomplete capture", async () => {
  const reason = { requested: "stop during initial navigation" };
  const completed = scriptScenarioFixture();
  const {
    completeness: _completeness,
    steps: _steps,
    browser,
    ...retained
  } = completed;
  const partial: BrowserScenarioPartialObservation = {
    kind: "browser-scenario-observation",
    capture: {
      ...retained,
      browser: { ...browser, cleanup: "incomplete" },
      steps: [],
    },
  };
  const failure = new AnalysisCancelledError("capture_browser_scenario", {
    cause: reason,
    partialObservation: partial,
  });
  const result = await runScenario(failure);
  expectKeptPartial(expectOwnerError(result, failure, reason), partial);
});

it("interprets only the retained observation's own JSON fields", async () => {
  let reads = 0;
  const partial = Object.defineProperty(
    { capture: { completed: "source fact" } },
    "kind",
    {
      get: () => {
        reads++;
        throw new Error("Hidden kind is not part of the observation");
      },
    },
  );
  const failure = new AnalysisCancelledError("capture_browser_scenario", {
    partialObservation: partial as never,
  });
  const result = await runScenario(failure);
  expectOwnerError(result, failure, failure.cause);
  expect(reads).toBe(0);
  expect(failure.partialObservation).toEqual({
    capture: { completed: "source fact" },
  });
});

it.each([{ steps: [undefined] }, { started_at: Number.NaN }])(
  "drops a non-JSON incomplete scenario capture and keeps cancellation primary",
  async (capturePartial) => {
    const reason = { requested: "stop during initial navigation" };
    const partial: BrowserScenarioPartialObservation = {
      kind: "browser-scenario-observation",
      capture: capturePartial as never,
    };
    const failure = new AnalysisCancelledError("capture_browser_scenario", {
      cause: reason,
      partialObservation: partial,
    });
    const result = await runScenario(failure);
    expectDroppedPartial(
      expectOwnerError(result, failure, reason),
      "Browser scenario provider retained a non-JSON incomplete observation.",
    );
  },
);

it("rejects a successful capture that is not a completed scenario", async () => {
  const provider: BrowserScenarioCapturePort = {
    identity: () => ({ id: "fixture", name: "fixture", version: "1" }),
    captureScenario: async () => ok({} as BrowserScenarioCapture),
  };
  const result = await captureBrowserScenario(provider, scenario);
  if (result.ok) throw new Error("Expected a completed-capture refusal");
  expect(result.error).toBeInstanceOf(AnalysisOutputError);
  expect(result.error.message).toContain(
    "returned a malformed completed capture",
  );
  expect(result.error.partialObservation).toBeUndefined();
});

it("projects scenario own JSON before inspecting a hidden known property", async () => {
  let reads = 0;
  const { browser: _browser, ...rest } = capture;
  const source = Object.defineProperty(rest, "browser", {
    get: () => {
      reads++;
      throw new Error("hidden scenario browser getter");
    },
  });
  const result = await captureBrowserScenario(
    {
      identity: () => scenarioIdentity,
      captureScenario: async () => ok(source as BrowserScenarioCapture),
    },
    scenario,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
  expect(reads).toBe(0);
});

it.each([false, true])(
  "retains scenario nested own metadata (cleanup primary: %s)",
  async (cleanup) => {
    const source = {
      ...capture,
      steps: capture.steps.map((step) => ({
        ...step,
        before_url: {
          ...step.before_url,
          provider_metadata: { source_id: "caller-source" },
        },
      })),
    };
    const primary = new AnalysisCancelledError("capture_browser_scenario", {
      partialObservation: {
        kind: "browser-scenario-observation",
        capture: source,
      },
    });
    const failure = new BrowserObservationError(
      "capture_browser_scenario",
      "cleanup_failed",
      {
        cleanupPrimary: primary,
        cleanup: {
          reason: "controlled close failure",
          resources: ["browser process"],
        },
      },
    );
    const result = await captureBrowserScenario(
      {
        identity: () => scenarioIdentity,
        captureScenario: async () => (cleanup ? err(failure) : ok(source)),
      },
      scenario,
    );
    const evidence = result.ok
      ? result.value
      : parseEvidence(primary.partialObservation);
    if (cleanup) {
      expect(result).toMatchObject({ ok: false });
      failure.resolveCleanup();
      expect(resolvedAnalysisError(failure)).toBe(primary);
    } else expect(result.ok).toBe(true);
    expect(evidence.raw_result).toEqual(source);
    expect(evidence.normalized_result).not.toHaveProperty(
      "steps.0.before_url.provider_metadata",
    );
  },
);

it("omits redundant raw scenario JSON for an unchanged capture", async () => {
  const result = await captureBrowserScenario(
    {
      identity: () => scenarioIdentity,
      captureScenario: async () => ok(capture),
    },
    scenario,
  );
  if (!result.ok) throw result.error;
  expect(result.value.raw_result).toBeNull();
});

it("retains only post-redaction scenario source while preserving harmless metadata", async () => {
  const selected = browserScenarioInputSchema.parse({
    ...scenario,
    secrets: [
      { secret_id: "selected", environment_variable: "DECLARED_VALUE" },
    ],
  });
  const secret = "explicit-source-secret";
  const privacy = resolveScenarioSecrets(selected, { DECLARED_VALUE: secret });
  const sanitized = privacy.sanitizeUrl(
    `https://transport-user:transport-password@fixture.test/?selected=${secret}&token=public-local-value`,
  );
  const source = {
    ...capture,
    steps: capture.steps.map((step) => ({
      ...step,
      before_url: {
        ...sanitized,
        provider_metadata: { source_id: "harmless-source" },
      },
    })),
  };
  const result = await captureBrowserScenario(
    {
      identity: () => scenarioIdentity,
      captureScenario: async () => ok(source),
    },
    selected,
  );
  if (!result.ok) throw result.error;
  expect(result.value.raw_result).toEqual(source);
  const recorded = JSON.stringify(result.value);
  for (const privateValue of [secret, "transport-user", "transport-password"])
    expect(recorded).not.toContain(privateValue);
  expect(recorded).toContain("harmless-source");
  expect(recorded).toContain("public-local-value");
  expect(sanitized.redacted).toBe(true);
});
