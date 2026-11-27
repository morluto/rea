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
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
  type BrowserScenarioPartialObservation,
} from "../domain/browserScenarioCapture.js";
import { err, ok } from "../domain/result.js";
import { scriptScenarioFixture } from "../../tests/fixtures/webScriptCapture.js";
import type { BrowserScenarioCapturePort } from "../ports/BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "./BrowserScenarioCaptureService.js";
import {
  expectDroppedPartial,
  expectKeptPartial,
  expectOwnerError,
} from "../../tests/fixtures/ownerObservationExpectation.js";
import { releaseOwnedCleanup } from "../../tests/support/cleanupRelease.js";

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
const runScenario = (failure: AnalysisError) =>
  captureBrowserScenario(
    {
      identity: () => scenarioIdentity,
      captureScenario: async () => err(failure),
    },
    scenario,
  );

it.each([
  {
    kind: "direct cancellation",
    cleanup: false,
    wrapped: false,
    wrapperFacts: false,
  },
  {
    kind: "direct cleanup failure",
    cleanup: true,
    wrapped: false,
    wrapperFacts: true,
  },
  {
    kind: "cleanup primary",
    cleanup: true,
    wrapped: true,
    wrapperFacts: false,
  },
  { kind: "shared partial", cleanup: true, wrapped: true, wrapperFacts: true },
])(
  "promotes completed partial captures to Evidence ($kind)",
  async ({ cleanup, wrapped, wrapperFacts }) => {
    const partial = { kind: "browser-scenario-observation" as const, capture };
    const primary = new AnalysisCancelledError("capture_browser_scenario", {
      partialObservation: partial,
    });
    const failure = cleanup
      ? new BrowserObservationError(
          "capture_browser_scenario",
          "cleanup_failed",
          {
            ...(wrapped ? { cleanupPrimary: primary } : {}),
            cleanup: {
              reason: "browser close failed",
              resources: ["browser process"],
            },
            ...(wrapperFacts ? { partialObservation: partial } : {}),
          },
        )
      : primary;

    const result = await runScenario(failure);
    if (result.ok) throw new Error("Expected retained capture");
    expect(result.error).toBe(failure);
    expect(failure.cleanupIncomplete).toBe(cleanup);
    if (wrapped) releaseOwnedCleanup(failure);
    const owner = resolvedAnalysisError(failure);
    expect(owner).toBe(wrapped ? primary : failure);
    if (wrapped && wrapperFacts)
      expect(failure.partialObservation).toBe(primary.partialObservation);
    expect(parseEvidence(owner.partialObservation)).toMatchObject({
      operation: "capture_browser_scenario",
      provider: scenarioIdentity,
      normalized_result: capture,
    });
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

it.each([false, true])(
  "delivers completed Evidence without redundant source (cancelled during capture: %s)",
  async (cancelled) => {
    const caller = new AbortController();
    const reason = { requested: "stop after capture" };
    const provider: BrowserScenarioCapturePort = {
      identity: () => scenarioIdentity,
      captureScenario: async (received, options) => {
        expect(received).toBe(scenario);
        expect(options?.signal).toBe(caller.signal);
        if (cancelled) caller.abort(reason);
        return ok(capture);
      },
    };
    const result = await captureBrowserScenario(provider, scenario, {
      signal: caller.signal,
    });
    expect(result.ok).toBe(!cancelled);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
    }
    expect(
      result.ok ? result.value : parseEvidence(result.error.partialObservation),
    ).toMatchObject({
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
      raw_result: null,
    });
  },
);

it.each(["startup", "failed step"] as const)(
  "keeps the %s cancellation observation partial",
  async (phase) => {
    const { completeness: _completeness, ...retained } = capture;
    const partial: BrowserScenarioPartialObservation = {
      kind: "browser-scenario-observation",
      capture:
        phase === "startup"
          ? {
              ...retained,
              browser: { ...capture.browser, cleanup: "incomplete" },
              steps: [],
            }
          : browserScenarioCaptureSchema.parse({
              ...capture,
              steps: [
                capture.steps[0],
                { ...capture.steps[1], status: "failed", error: "step failed" },
              ],
            }),
    };
    const reason = { phase };
    const failure = new AnalysisCancelledError("capture_browser_scenario", {
      cause: reason,
      partialObservation: partial,
    });
    const result = await runScenario(failure);
    expectKeptPartial(expectOwnerError(result, failure, reason), partial);
  },
);

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

it("returns Evidence when a completed capture reports incomplete cleanup", async () => {
  const degraded: BrowserScenarioCapture = {
    ...capture,
    browser: { ...capture.browser, cleanup: "incomplete" },
    limitations: [
      ...capture.limitations,
      "Browser cleanup could not be confirmed: browser close timed out. Reported resources may remain: browser_transport.",
    ],
  };
  const provider: BrowserScenarioCapturePort = {
    identity: () => ({ id: "fixture", name: "fixture", version: "1" }),
    captureScenario: async () => ok(degraded),
  };
  const result = await captureBrowserScenario(provider, scenario);
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error("Expected the completed capture returned as Evidence");
  expect(result.value.evidence_id).toMatch(/^ev_/);
  expect(result.value.normalized_result).toMatchObject({
    browser: { cleanup: "incomplete" },
  });
});

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
  "retains sanitized source and its own metadata (cleanup primary: %s)",
  async (cleanup) => {
    const selected = browserScenarioInputSchema.parse({
      ...scenario,
      secrets: [
        { secret_id: "selected", environment_variable: "DECLARED_VALUE" },
      ],
    });
    const secret = "explicit-source-secret";
    const privacy = resolveScenarioSecrets(selected, {
      DECLARED_VALUE: secret,
    });
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
      selected,
    );
    const evidence = result.ok
      ? result.value
      : parseEvidence(primary.partialObservation);
    if (cleanup) {
      expect(result).toMatchObject({ ok: false });
      releaseOwnedCleanup(failure);
      expect(resolvedAnalysisError(failure)).toBe(primary);
    } else expect(result.ok).toBe(true);
    expect(evidence.raw_result).toEqual(source);
    expect(evidence.normalized_result).not.toHaveProperty(
      "steps.0.before_url.provider_metadata",
    );
    const recorded = JSON.stringify(evidence);
    for (const value of [secret, "transport-user", "transport-password"])
      expect(recorded).not.toContain(value);
    expect(recorded).toContain("public-local-value");
    expect(sanitized.redacted).toBe(true);
  },
);
