// Fake-backed composition coverage; real browser verification lives in
// `npm run verify:browser`.
import { describe, expect, it, vi } from "vitest";

import type { BrowserScenarioSessionPort } from "./BrowserScenarioSessionPort.js";
import { PlaywrightBrowserScenarioProvider } from "./PlaywrightBrowserScenarioProvider.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { PlaywrightScenarioBrowserCleanupOwner } from "./PlaywrightScenarioBrowser.js";
import {
  browserScenarioSchema,
  type BrowserScenario,
} from "../domain/browserScenario.js";
import type { BrowserScenarioAction } from "../domain/browserScenarioValues.js";
import {
  browserStepArtifactsSchema,
  type BrowserScenarioEvent,
  type BrowserStepArtifacts,
} from "../domain/browserScenarioCaptureValues.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";

const scenario = (
  options: {
    readonly mode?: "launch" | "connect";
    readonly captures?: readonly (
      | "screenshot"
      | "dom"
      | "accessibility"
      | "url"
      | "history"
      | "storage"
    )[];
    readonly events?: readonly (
      | "console"
      | "page-errors"
      | "network"
      | "websockets"
      | "frames"
      | "workers"
      | "popups"
      | "downloads"
    )[];
    readonly actions?: number;
  } = {},
): BrowserScenario =>
  browserScenarioSchema.parse({
    browser:
      options.mode === "connect"
        ? {
            mode: "connect",
            cdp_endpoint: "http://127.0.0.1:9222",
            target_id: "page-1",
          }
        : {
            mode: "launch",
            executable_path: "/opt/chromium",
          },
    start_url: { url: "https://app.example.test/" },
    actions: Array.from({ length: options.actions ?? 1 }, (_, index) => ({
      step_id: `wait_${index}`,
      action: "wait_for_timeout",
      duration_ms: 1,
    })),
    storage: {},
    secrets: [],
    capture: {
      after_each_step: options.captures ?? ["url"],
      at_end: [],
      events: options.events ?? [],
    },
  });

type SnapshotKind = BrowserScenario["capture"]["after_each_step"][number];

interface FakeSessionFailures {
  readonly incomplete?: boolean;
  readonly action?: Error;
  readonly capture?: { readonly call: number; readonly error: Error };
  readonly close?: Error;
}

const artifactState = (
  kind: SnapshotKind,
  requested: ReadonlySet<SnapshotKind>,
  incomplete: boolean,
) => {
  if (!requested.has(kind)) return { state: "not_requested" as const };
  if (kind === "url")
    return {
      state: "captured" as const,
      value: sanitizeBrowserUrl("https://app.example.test/current"),
    };
  if (incomplete && kind === "screenshot")
    return {
      state: "truncated" as const,
      observed: 2_048,
      retained: 0,
      reason: "fixture limit",
    };
  return { state: "missing" as const, reason: "fixture unavailable" };
};

class FakeSession implements BrowserScenarioSessionPort {
  readonly product = "Fake Chromium";
  readonly version = "1";
  readonly initialUrl = "about:blank";
  readonly processOwnership: "provider-owned" | "external";
  closeCalls = 0;
  performCalls = 0;
  captureCalls = 0;
  onPerform: (() => void) | undefined;
  eventGaps: readonly string[] = [];
  eventItems: readonly BrowserScenarioEvent[] = [];

  constructor(
    readonly mode: "launch" | "connect",
    private readonly failures: FakeSessionFailures = {},
  ) {
    this.processOwnership = mode === "launch" ? "provider-owned" : "external";
  }

  currentUrl() {
    return "https://app.example.test/current";
  }

  sanitizeUrl(value: string) {
    return sanitizeBrowserUrl(value);
  }

  setStep(_index: number) {}

  nextEventSequence() {
    return 1;
  }

  lastEventSequence() {
    return 0;
  }

  events(): {
    readonly retained: number;
    readonly dropped: number;
    readonly items: readonly BrowserScenarioEvent[];
  } {
    return {
      retained: this.eventItems.length,
      dropped: 0,
      items: this.eventItems,
    };
  }

  eventLimitations(): readonly string[] {
    return this.eventGaps;
  }

  async perform(_action: BrowserScenarioAction, signal?: AbortSignal) {
    this.performCalls += 1;
    this.onPerform?.();
    if (signal?.aborted === true) throw new Error("request cancelled");
    if (this.failures.action !== undefined) throw this.failures.action;
  }

  capture(
    requested: ReadonlySet<SnapshotKind>,
    _signal?: AbortSignal,
  ): Promise<BrowserStepArtifacts> {
    this.captureCalls += 1;
    if (this.failures.capture?.call === this.captureCalls)
      return Promise.reject(this.failures.capture.error);
    return Promise.resolve(
      browserStepArtifactsSchema.parse({
        screenshot: artifactState(
          "screenshot",
          requested,
          this.failures.incomplete === true,
        ),
        dom: artifactState("dom", requested, this.failures.incomplete === true),
        accessibility: artifactState(
          "accessibility",
          requested,
          this.failures.incomplete === true,
        ),
        url: artifactState("url", requested, this.failures.incomplete === true),
        history: artifactState(
          "history",
          requested,
          this.failures.incomplete === true,
        ),
        storage: artifactState(
          "storage",
          requested,
          this.failures.incomplete === true,
        ),
      }),
    );
  }

  close() {
    this.closeCalls += 1;
    if (this.failures.close !== undefined)
      return Promise.reject(this.failures.close);
    return Promise.resolve(
      this.mode === "launch"
        ? ("terminated-owned-process" as const)
        : ("disconnected-external" as const),
    );
  }

  redactError(error: unknown) {
    return error instanceof Error
      ? error.message.replaceAll("secret", "[REDACTED]")
      : "fixture failure";
  }
}

describe("PlaywrightBrowserScenarioProvider", () => {
  it("makes reported event gaps ineligible for equality even in launch mode", async () => {
    const session = new FakeSession("launch");
    session.eventGaps = ["Popup frames before discovery are unavailable"];
    const provider = new PlaywrightBrowserScenarioProvider(() =>
      Promise.resolve(session),
    );
    const result = await provider.captureScenario(
      scenario({ events: ["frames"] }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.completeness).toMatchObject({
      status: "incomplete",
      equality_eligible: false,
      missing_sections: ["events"],
    });
    expect(result.value.limitations).toContain(session.eventGaps[0]);
  });
  it("returns an initial state and every step beyond the former action ceiling", async () => {
    const session = new FakeSession("launch");
    const provider = new PlaywrightBrowserScenarioProvider(() =>
      Promise.resolve(session),
    );
    const result = await provider.captureScenario(scenario({ actions: 129 }));
    if (!result.ok) throw result.error;
    expect(result.value.scenario.action_count).toBe(129);
    expect(result.value.steps).toHaveLength(130);
    expect(result.value.steps.at(-1)?.step_id).toBe("wait_128");
  });

  it("makes missing and truncated captures ineligible for equality", async () => {
    const session = new FakeSession("launch", { incomplete: true });
    const provider = new PlaywrightBrowserScenarioProvider(() =>
      Promise.resolve(session),
    );
    const result = await provider.captureScenario(
      scenario({ captures: ["screenshot", "dom"] }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.completeness).toMatchObject({
      status: "truncated",
      equality_eligible: false,
      missing_sections: ["dom"],
      truncated_sections: ["screenshot"],
    });
  });

  it("records one failed step, cancels later actions, and still cleans up", async () => {
    const session = new FakeSession("launch", {
      action: new Error("fixture secret action failure"),
    });
    const provider = new PlaywrightBrowserScenarioProvider(() =>
      Promise.resolve(session),
    );
    const result = await provider.captureScenario(scenario({ actions: 2 }));
    if (!result.ok) throw result.error;
    expect(result.value.steps.map(({ status }) => status)).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(result.value.steps[1]?.error).toBe(
      "fixture [REDACTED] action failure",
    );
    expect(session.performCalls).toBe(1);
    expect(session.closeCalls).toBe(1);
    expect(result.value.completeness.equality_eligible).toBe(false);
  });

  it("disconnects external CDP sessions and marks pre-attach events missing", async () => {
    const session = new FakeSession("connect");
    const provider = new PlaywrightBrowserScenarioProvider(() =>
      Promise.resolve(session),
    );
    const result = await provider.captureScenario(
      scenario({ mode: "connect" }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.browser).toMatchObject({
      process_ownership: "external",
      cleanup: "disconnected-external",
    });
    expect(result.value.completeness).toMatchObject({
      status: "incomplete",
      equality_eligible: false,
      missing_sections: ["events"],
    });
    expect(session.closeCalls).toBe(1);
  });
});

describe("PlaywrightBrowserScenarioProvider cleanup", () => {
  it("returns a cleanup failure with completed observations when close fails", async () => {
    const session = new FakeSession("launch", {
      action: new Error("fixture secret action failure"),
      close: new Error("browser close failed"),
    });
    const provider = new PlaywrightBrowserScenarioProvider(() =>
      Promise.resolve(session),
    );
    const result = await provider.captureScenario(scenario());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const projection = projectAnalysisError(result.error);
    expect(projection).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        cleanup: "incomplete",
        resources: ["browser_transport"],
        partial_observation: {
          kind: "browser-scenario-observation",
          capture: {
            browser: { cleanup: "incomplete" },
            steps: [
              { step_id: "scenario_start" },
              { step_id: "wait_0", status: "failed" },
            ],
          },
        },
      },
    });
    expect(session.closeCalls).toBe(1);
  });
});

describe("PlaywrightBrowserScenarioProvider operation failures", () => {
  it.each([{ cleanupFails: false }, { cleanupFails: true }])(
    "retains typed partial data when operation fails and cleanupFails=$cleanupFails",
    async ({ cleanupFails }) => {
      const session = new FakeSession("launch", {
        capture: {
          call: 2,
          error: new AnalysisOutputError(
            "capture_browser_scenario",
            "step capture failed",
            {
              capturedOutput: {
                stdout: "partial stdout",
                stderr: "",
                truncated: false,
              },
              cleanup: {
                reason: "capture cleanup is uncertain",
                resources: ["capture_handle"],
              },
            },
          ),
        },
        ...(cleanupFails ? { close: new Error("browser close failed") } : {}),
      });
      session.eventItems = [
        {
          sequence: 1,
          step_index: 0,
          kind: "console",
          level: "log",
          text: "navigation started",
          url: sanitizeBrowserUrl("https://app.example.test/"),
        },
      ];
      const provider = new PlaywrightBrowserScenarioProvider(() =>
        Promise.resolve(session),
      );
      const result = await provider.captureScenario(scenario());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const projection = projectAnalysisError(result.error);
      expect(projection).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          diagnostics: {
            primary_error: {
              code: "cleanup_incomplete",
              details: {
                operation: "capture_browser_scenario",
                reason: "step capture failed",
              },
            },
            ...(cleanupFails
              ? { cleanup_error: { code: "execution_failure" } }
              : {}),
          },
          partial_observation: {
            kind: "browser-scenario-observation",
            capture: {
              browser: {
                cleanup: cleanupFails
                  ? "incomplete"
                  : "terminated-owned-process",
              },
              steps: [{ step_id: "scenario_start" }],
              events: {
                items: [
                  expect.objectContaining({ text: "navigation started" }),
                ],
              },
            },
          },
        },
      });
      expect(result.error.capturedOutput).toEqual({
        stdout: "partial stdout",
        stderr: "",
        truncated: false,
      });
      expect(result.error.cleanup).toEqual(
        cleanupFails
          ? {
              reason: "browser close failed",
              resources: ["browser_transport"],
            }
          : {
              reason: "capture cleanup is uncertain",
              resources: ["capture_handle"],
            },
      );
      expect(session.closeCalls).toBe(1);
    },
  );
});

describe("PlaywrightBrowserScenarioProvider cancellation and timeout", () => {
  it.each([
    {
      name: "cancellation",
      error: new AnalysisCancelledError("capture_browser_scenario"),
      code: "cancelled",
      category: "cancelled",
      details: { operation: "capture_browser_scenario", cleanup: "complete" },
    },
    {
      name: "timeout",
      error: new AnalysisTimeoutError("capture_browser_scenario", 250),
      code: "provider_timeout",
      category: "timeout",
      details: { operation: "capture_browser_scenario", timeout_ms: 250 },
    },
  ])(
    "preserves $name category and details when cleanup succeeds",
    async ({ error, code, category, details }) => {
      const session = new FakeSession("launch", {
        capture: { call: 1, error },
      });
      const provider = new PlaywrightBrowserScenarioProvider(() =>
        Promise.resolve(session),
      );
      const result = await provider.captureScenario(scenario());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const projection = projectAnalysisError(result.error);
      expect(projection).toMatchObject({
        code,
        category,
        details: {
          ...details,
          partial_observation: {
            kind: "browser-scenario-observation",
            capture: { browser: { cleanup: "terminated-owned-process" } },
          },
        },
      });
      expect(session.closeCalls).toBe(1);
    },
  );
});

describe("PlaywrightBrowserScenarioProvider request cancellation", () => {
  it("does not open a session for an already-cancelled request", async () => {
    let opens = 0;
    const provider = new PlaywrightBrowserScenarioProvider(() => {
      opens += 1;
      return Promise.resolve(new FakeSession("launch"));
    });
    const controller = new AbortController();
    controller.abort();
    const result = await provider.captureScenario(scenario(), {
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(opens).toBe(0);
  });

  it("cancels an active action and still closes the session", async () => {
    const controller = new AbortController();
    const session = new FakeSession("launch");
    session.onPerform = () => controller.abort();
    const provider = new PlaywrightBrowserScenarioProvider(() =>
      Promise.resolve(session),
    );
    const result = await provider.captureScenario(scenario(), {
      signal: controller.signal,
    });
    if (!result.ok) throw result.error;
    expect(result.value.steps[1]?.status).toBe("cancelled");
    expect(session.closeCalls).toBe(1);
  });
});

it("shares concurrent close and retries browser cleanup after failure", async () => {
  const browserClose = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("browser close failed"))
    .mockResolvedValue(undefined);
  const removeProfile = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const finishEvents = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const cleanupSettlements: boolean[] = [];
  const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: browserClose,
    removeProfile,
    onSettled: (browserClosed) => cleanupSettlements.push(browserClosed),
  });

  const first = cleanup.close(finishEvents);
  const concurrent = cleanup.close(finishEvents);
  await expect(first).rejects.toMatchObject({ reason: "cleanup_failed" });
  await expect(concurrent).rejects.toMatchObject({ reason: "cleanup_failed" });
  expect(browserClose).toHaveBeenCalledTimes(1);
  expect(removeProfile).not.toHaveBeenCalled();
  expect(finishEvents).toHaveBeenCalledTimes(1);
  expect(cleanupSettlements).toEqual([false]);

  await expect(cleanup.close(finishEvents)).resolves.toBeUndefined();
  await expect(cleanup.close(finishEvents)).resolves.toBeUndefined();
  expect(browserClose).toHaveBeenCalledTimes(2);
  expect(removeProfile).toHaveBeenCalledTimes(1);
  expect(finishEvents).toHaveBeenCalledTimes(1);
  expect(cleanupSettlements).toEqual([false, true]);
});

it("reports event finalization failure before allowing settled cleanup retries", async () => {
  const finishEvents = vi
    .fn<() => Promise<void>>()
    .mockRejectedValue(new Error("event finalization failed"));
  const closeBrowser = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser,
    removeProfile: undefined,
  });

  await expect(cleanup.close(finishEvents)).rejects.toMatchObject({
    reason: "cleanup_failed",
    cleanup: { reason: "event finalization failed" },
  });
  await expect(cleanup.close(finishEvents)).resolves.toBeUndefined();
  expect(finishEvents).toHaveBeenCalledTimes(1);
  expect(closeBrowser).toHaveBeenCalledTimes(1);
});
