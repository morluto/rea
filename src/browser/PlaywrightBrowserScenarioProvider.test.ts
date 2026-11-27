import {
  controlledCleanup,
  phaseGate,
} from "../../tests/support/lifecycleHarness.js";
import { EventEmitter } from "node:events";
import type { BrowserContext, Page, Request, Response } from "playwright-core";
import { capturePlaywrightStepArtifacts } from "./PlaywrightScenarioArtifacts.js";
import { resolveScenarioSecrets } from "../../tests/fixtures/browserScenarioSecrets.js";
import {
  failBrowserScenarioOperation,
  PlaywrightScenarioBrowserCleanupOwner,
} from "./PlaywrightScenarioBrowser.js";
import { AnalysisCleanupLease } from "../resources/AnalysisCleanupLease.js";
// Fake-backed composition coverage; real browser verification lives in
// `npm run verify:browser`.
import { describe, expect, it, vi } from "vitest";

import type { BrowserScenarioSessionPort } from "./BrowserScenarioSessionPort.js";
import { PlaywrightBrowserScenarioProvider } from "./PlaywrightBrowserScenarioProvider.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { primaryAnalysisError } from "../domain/analysisErrorBase.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
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
import { PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION } from "../domain/browserNetworkEvidence.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { compareBrowserScenarios } from "../domain/browserScenarioDiff.js";
import { compareBrowserScenariosInputSchema } from "../domain/browserScenarioDiffValues.js";
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

const connectedPlatformEmulationLimitation = expect.stringContaining(
  "Detaching a CDP page session may clear caller-owned navigator.platform emulation",
);

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
  cleanupLease = new AnalysisCleanupLease(async () => {
    await this.close();
  }, ["browser_transport"]);
  closeCalls = 0;
  performCalls = 0;
  captureCalls = 0;
  onPerform: (() => void) | undefined;
  onClose: (() => void) | undefined;
  captureFinalized?: () => boolean;
  eventGaps: readonly string[] = [];
  storageGaps: readonly string[] = [];
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

  events(): ReturnType<BrowserScenarioSessionPort["events"]> {
    return {
      retained: this.eventItems.length,
      dropped: 0,
      items: this.eventItems,
      omissions: {
        by_kind: [],
        network_transactions: [],
        network_transaction_range: null,
      },
    };
  }

  eventLimitations(): readonly string[] {
    return this.eventGaps;
  }

  storageLimitations(): readonly string[] {
    return this.storageGaps;
  }

  async perform(_action: BrowserScenarioAction, signal?: AbortSignal) {
    this.performCalls += 1;
    this.onPerform?.();
    if (signal?.aborted === true)
      throw new AnalysisCancelledError("capture_browser_scenario", {
        cause: signal.reason,
      });
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
    this.onClose?.();
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

it("compares retained network observations despite a failed subresource", async () => {
  const selected = scenario({ events: ["network", "console", "network"] });
  const input = browserScenarioSchema.parse({
    ...selected,
    capture: {
      ...selected.capture,
      network: { response_body: true },
    },
  });
  const capture = async (reply: string) => {
    const context = new EventEmitter();
    const page = new EventEmitter() as unknown as Page;
    const events = new PlaywrightScenarioEvents({
      page,
      context: context as unknown as BrowserContext,
      ownsContext: true,
      enabled: new Set(input.capture.events),
      network: input.capture.network,
      secrets: resolveScenarioSecrets(input, {}),
    });
    const failedBody = vi.fn(async () => Buffer.from("unread"));
    for (const failed of [true, false]) {
      const request = {
        method: () => "GET",
        url: () =>
          `https://app.example.test/${failed ? "extra.js" : "api/data"}`,
        resourceType: () => (failed ? "script" : "fetch"),
        headers: () => ({}),
        redirectedFrom: () => null,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      } as unknown as Request;
      const response = {
        request: () => request,
        url: () => request.url(),
        status: () => (failed ? 404 : 200),
        headers: () => ({}),
        body: failed ? failedBody : async () => Buffer.from(reply),
      } as unknown as Response;
      context.emit("request", request);
      context.emit("response", response);
      context.emit(failed ? "requestfailed" : "requestfinished", request);
    }
    const session = new FakeSession("launch");
    vi.spyOn(session, "events").mockImplementation(() => events.result());
    vi.spyOn(session, "eventLimitations").mockImplementation(() =>
      events.limitations(),
    );
    vi.spyOn(session, "nextEventSequence").mockImplementation(() =>
      events.nextSequence(),
    );
    vi.spyOn(session, "lastEventSequence").mockImplementation(() =>
      events.lastSequence(),
    );
    vi.spyOn(session, "close").mockImplementation(async () => {
      await events.finish();
      return "terminated-owned-process";
    });
    const provider = new PlaywrightBrowserScenarioProvider(async () => session);
    const result = await provider.captureScenario(input);
    if (!result.ok) throw result.error;
    expect(failedBody).not.toHaveBeenCalled();
    expect(result.value.completeness).toMatchObject({
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
    });
    expect(result.value.scenario.event_families).toEqual([
      "console",
      "network",
    ]);
    expect(result.value.limitations).toContain(
      PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION,
    );
    expect(result.value.events.items).toContainEqual(
      expect.objectContaining({
        kind: "network-content",
        body: expect.objectContaining({
          state: "captured",
          representation: "playwright-response-body-bytes",
        }),
      }),
    );
    expect(result.value.events.dropped).toBe(0);
    expect(result.value.events.items).toContainEqual(
      expect.objectContaining({
        kind: "network-content",
        body: {
          state: "unavailable",
          reason: "request-failed",
          message: "net::ERR_ABORTED",
        },
      }),
    );
    return result.value;
  };
  const before = await capture('{"value":1}');
  for (const [reply, expected] of [
    ['{"value":1}', "unchanged"],
    ['{"value":2}', "changed"],
  ] as const) {
    const after = await capture(reply);
    const comparison = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
      }),
    );
    expect(comparison.overall_status).toBe(expected);
    expect(comparison.steps[0]?.status).toBe(expected);
  }
});

describe("PlaywrightBrowserScenarioProvider", () => {
  it.each([
    {
      section: "events",
      limitation: "Popup frames before discovery are unavailable",
    },
    {
      section: "storage",
      limitation:
        "First-script seed coverage is unknown for popup top-level contexts",
    },
  ])(
    "retains completed observations when $section coverage is incomplete",
    async ({ section, limitation }) => {
      const session = new FakeSession("launch");
      if (section === "events") session.eventGaps = [limitation];
      else session.storageGaps = [limitation];
      const provider = new PlaywrightBrowserScenarioProvider(
        async () => session,
      );
      const result = await provider.captureScenario(
        scenario({ events: ["frames"] }),
      );
      if (!result.ok) throw result.error;
      expect(result.value.completeness).toMatchObject({
        status: "incomplete",
        equality_eligible: false,
        missing_sections: [section],
      });
      expect(result.value.steps.map(({ status }) => status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(result.value.limitations).toContain(limitation);
    },
  );

  it("retains all long-scenario steps and monotonic elapsed time", async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeSession("launch");
      session.onPerform = () => {
        if (session.performCalls !== 1) return;
        vi.setSystemTime(Date.now() - 10_000);
        vi.advanceTimersByTime(37);
      };
      const provider = new PlaywrightBrowserScenarioProvider(
        async () => session,
      );
      const result = await provider.captureScenario(scenario({ actions: 129 }));
      if (!result.ok) throw result.error;
      expect(result.value.scenario.action_count).toBe(129);
      expect(result.value.duration_ms).toBe(37);
      expect(result.value.steps).toHaveLength(130);
      expect(result.value.steps[0]?.elapsed_ms).toBe(0);
      expect(result.value.steps[1]?.elapsed_ms).toBe(37);
      expect(result.value.steps.at(-1)).toMatchObject({
        step_id: "wait_128",
        elapsed_ms: 0,
      });
    } finally {
      vi.useRealTimers();
    }
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
    expect(result.value.steps[2]?.error).toBe(
      "not executed after an earlier action failure",
    );
    expect(session.performCalls).toBe(1);
    expect(session.closeCalls).toBe(1);
    expect(result.value.completeness.equality_eligible).toBe(false);
  });
});

it.each([false, true])(
  "reports external browser coverage in attached observations (capture failed: %s)",
  async (captureFailed) => {
    const session = new FakeSession(
      "connect",
      captureFailed
        ? { capture: { call: 1, error: new Error("fixture capture failure") } }
        : {},
    );
    const provider = new PlaywrightBrowserScenarioProvider(async () => session);
    const result = await provider.captureScenario(
      scenario({ mode: "connect" }),
    );
    expect(result.ok).toBe(!captureFailed);
    const attached = {
      browser: {
        process_ownership: "external",
        cleanup: "disconnected-external",
      },
      limitations: expect.arrayContaining([
        connectedPlatformEmulationLimitation,
      ]),
    };
    if (result.ok)
      expect(result.value).toMatchObject({
        ...attached,
        completeness: {
          status: "incomplete",
          equality_eligible: false,
          missing_sections: ["events"],
        },
      });
    else
      expect(projectAnalysisError(result.error)).toMatchObject({
        details: { partial_observation: { capture: attached } },
      });
    expect(session.closeCalls).toBe(1);
  },
);

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

it.each([false, true])(
  "returns a completed capture after cleanup failure only when finalization settled (%s)",
  async (finalized) => {
    const session = new FakeSession("launch", {
      close: new Error("browser close timed out"),
    });
    session.captureFinalized = () => finalized;
    const provider = new PlaywrightBrowserScenarioProvider(async () => session);
    try {
      const result = await provider.captureScenario(scenario());
      if (finalized) {
        if (!result.ok) throw result.error;
        expect(result.value.browser.cleanup).toBe("incomplete");
        expect(result.value.completeness.status).toBe("complete");
        expect(result.value.limitations).toContain(
          "Browser cleanup could not be confirmed: browser close timed out. Reported resources may remain: browser_transport.",
        );
        await expect(provider.close()).rejects.toMatchObject({
          cleanupIncomplete: true,
        });
      } else {
        if (result.ok) throw new Error("Expected unfinished capture");
        expect(result.error.cleanupIncomplete).toBe(true);
        expect(result.error.partialObservation).toMatchObject({
          capture: { browser: { cleanup: "incomplete" } },
        });
        expect(result.error.partialObservation).not.toHaveProperty(
          "capture.completeness.status",
          "complete",
        );
      }
    } finally {
      session.close = async () => "terminated-owned-process";
      await provider.close();
    }
  },
);

it("preserves event gaps when finalized capture cleanup is incomplete", async () => {
  const session = new FakeSession("launch", {
    close: new Error("browser close timed out"),
  });
  session.captureFinalized = () => true;
  session.eventGaps = ["Selected response content was unavailable."];
  const provider = new PlaywrightBrowserScenarioProvider(async () => session);
  try {
    const result = await provider.captureScenario(scenario());
    if (!result.ok) throw result.error;
    expect(result.value.completeness).toMatchObject({
      equality_eligible: false,
      missing_sections: ["events"],
    });
  } finally {
    session.close = async () => "terminated-owned-process";
    await provider.close();
  }
});

it("redacts finalized capture cleanup diagnostics through the session owner", async () => {
  const session = new FakeSession("launch", {
    close: new ProviderCleanupError("fixture", ["secret-profile"], {
      reason: "secret close failed",
    }),
  });
  session.captureFinalized = () => true;
  const provider = new PlaywrightBrowserScenarioProvider(async () => session);
  try {
    const result = await provider.captureScenario(scenario());
    if (!result.ok) throw result.error;
    expect(result.value.limitations).toContain(
      "Browser cleanup could not be confirmed: [REDACTED] close failed. Reported resources may remain: [REDACTED]-profile.",
    );
    expect(JSON.stringify(result.value)).not.toContain("secret-profile");
    expect(JSON.stringify(result.value)).not.toContain("secret close failed");
  } finally {
    session.close = async () => "terminated-owned-process";
    await provider.close();
  }
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
          ...(cleanupFails
            ? {
                diagnostics: {
                  primary_error: {
                    code: "cleanup_incomplete",
                    details: {
                      operation: "capture_browser_scenario",
                      diagnostics: {
                        primary_error: {
                          details: { reason: "step capture failed" },
                        },
                      },
                    },
                  },
                  cleanup_error: { code: "cleanup_incomplete" },
                },
              }
            : { reason: "step capture failed" }),
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
                retained: 1,
                dropped: 0,
                items: [
                  expect.objectContaining({ text: "navigation started" }),
                ],
                omissions: {
                  by_kind: [],
                  network_transactions: [],
                  network_transaction_range: null,
                },
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
      expect(result.error.cleanupResources).toEqual(
        cleanupFails
          ? ["capture_handle", "browser_transport"]
          : ["capture_handle"],
      );
      if (!cleanupFails)
        expect(result.error.cleanup).toEqual({
          reason: "capture cleanup is uncertain",
          resources: ["capture_handle"],
        });
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
  it("refuses an already-cancelled request before opening a session", async () => {
    const open = vi.fn(async () => new FakeSession("launch"));
    const provider = new PlaywrightBrowserScenarioProvider(open);
    const reason = new Error("cancel before opening");
    const result = await provider.captureScenario(scenario(), {
      signal: AbortSignal.abort(reason),
    });
    if (result.ok) throw new Error("Expected cancelled admission");
    expect(result.error).toMatchObject({
      reason: "cancelled",
      cleanupIncomplete: false,
    });
    expect(result.error.cause).toBe(reason);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves completed steps when cancellation arrives during final close (refused: %s)",
    async (refused) => {
      const caller = new AbortController();
      const reason = { caller: "during final close" };
      const session = new FakeSession("launch");
      const refusal = new Error("fixture close failed");
      const close = vi.spyOn(session, "close");
      session.onClose = () => caller.abort(reason);
      if (refused)
        close.mockImplementationOnce(async () => {
          caller.abort(reason);
          throw refusal;
        });
      const provider = new PlaywrightBrowserScenarioProvider(
        async () => session,
      );
      try {
        const result = await provider.captureScenario(scenario(), {
          signal: caller.signal,
        });
        if (result.ok) throw new Error("Expected final-close cancellation");
        expect(result.error).toMatchObject({
          cleanupIncomplete: refused,
          cleanupResources: refused ? ["browser_transport"] : [],
          partialObservation: {
            kind: "browser-scenario-observation",
            capture: {
              browser: {
                cleanup: refused ? "incomplete" : "terminated-owned-process",
              },
              steps: [{ status: "completed" }, { status: "completed" }],
            },
          },
        });
        expect(primaryAnalysisError(result.error)).toBeInstanceOf(
          AnalysisCancelledError,
        );
        expect(primaryAnalysisError(result.error).cause).toBe(reason);
        expect(close).toHaveBeenCalledOnce();
        if (refused) {
          close.mockRejectedValueOnce(refusal);
          await expect(provider.close()).rejects.toMatchObject({
            operation: "capture_browser_scenario",
            cleanupIncomplete: true,
            cleanupResources: ["browser_transport"],
          });
          expect(result.error.cleanupIncomplete).toBe(true);
        }
        await provider.close();
        expect(result.error.cleanupIncomplete).toBe(false);
        expect(projectAnalysisError(result.error).code).toBe("cancelled");
        expect(close).toHaveBeenCalledTimes(refused ? 3 : 1);
      } finally {
        await provider.close();
      }
    },
  );
});

it("keeps failed event finalization failed across cleanup retries", async () => {
  const failure = new Error("event finalization failed");
  const finishEvents = vi.fn(async () => {
    throw failure;
  });
  const closeBrowser = vi.fn(async () => undefined);
  const cleanup = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: (disconnectAtBoundary) => disconnectAtBoundary(closeBrowser),
    removeProfile: undefined,
  });

  for (let attempt = 0; attempt < 2; attempt++)
    await expect(cleanup.close(finishEvents)).rejects.toMatchObject({
      reason: "cleanup_failed",
      cause: failure,
      cleanupResources: ["browser_events"],
    });
  expect(finishEvents).toHaveBeenCalledOnce();
  expect(closeBrowser).toHaveBeenCalledOnce();
});

it.each(["launch", "connect"] as const)(
  "reports locale coverage in %s success and retained operation/cleanup failures",
  async (mode) => {
    const input = scenario({ mode });
    input.environment.locale = "fr-FR";
    for (const failures of [
      {},
      {
        capture: {
          call: 1,
          error: new AnalysisCancelledError("capture_browser_scenario"),
        },
      },
      { close: new Error("fixture cleanup interrupted") },
    ]) {
      const session = new FakeSession(mode, failures);
      const provider = new PlaywrightBrowserScenarioProvider(
        async () => session,
      );
      const result = await provider.captureScenario(input);
      expect(result.ok).toBe(!("capture" in failures || "close" in failures));
      const expected = {
        limitations:
          mode === "connect"
            ? expect.arrayContaining([
                "Attached locale fr-FR applies to Intl formatting only; navigator.language(s) and Accept-Language remain caller-controlled. Use launch mode for matching page and request languages.",
              ])
            : expect.not.arrayContaining([
                expect.stringContaining("Attached locale"),
              ]),
      };
      if (result.ok) expect(result.value).toMatchObject(expected);
      else
        expect(projectAnalysisError(result.error)).toMatchObject({
          details: {
            partial_observation: {
              kind: "browser-scenario-observation",
              capture: expected,
            },
          },
        });
      expect(session.closeCalls).toBe(1);
    }
  },
);

it.each([false, true])(
  "follows the browser owner through provider recovery (operation failed: %s)",
  async (operationFailed) => {
    const reason = { caller: "authored capture cancellation" };
    const primary = new AnalysisCancelledError("capture_browser_scenario", {
      cause: reason,
    });
    const session = new FakeSession(
      "launch",
      operationFailed ? { capture: { call: 1, error: primary } } : {},
    );
    let denied = true;
    const owner = new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser: (disconnectAtBoundary) =>
        disconnectAtBoundary(async () => undefined),
      removeProfile: async () => {
        if (denied) throw new Error("profile removal denied");
      },
    });
    session.cleanupLease = owner.cleanupLease;
    session.close = async () => {
      await owner.close();
      return "terminated-owned-process";
    };
    const provider = new PlaywrightBrowserScenarioProvider(async () => session);
    try {
      const result = await provider.captureScenario(scenario());
      if (result.ok) throw new Error("Expected retained cleanup");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toEqual(["browser_profile"]);
      const partial = result.error.partialObservation;
      await expect(provider.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
      });
      denied = false;
      await provider.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(result.error.cleanupResources).toEqual([]);
      expect(result.error.partialObservation).toBe(partial);
      if (operationFailed) {
        expect(primaryAnalysisError(result.error)).toBe(primary);
        expect(primary.cause).toBe(reason);
        expect(projectAnalysisError(result.error)).toMatchObject({
          code: "cancelled",
        });
      }
    } finally {
      denied = false;
      await provider.close();
    }
  },
);

it("resolves the returned failure after retrying a plain session cleanup capability", async () => {
  const session = new FakeSession("launch");
  let denied = true;
  session.close = async () => {
    if (denied) throw new Error("authored session cleanup denial");
    return "terminated-owned-process";
  };
  const provider = new PlaywrightBrowserScenarioProvider(async () => session);
  try {
    const result = await provider.captureScenario(scenario());
    if (result.ok) throw new Error("Expected cleanup failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    const failed: unknown = await provider
      .close()
      .catch((cause: unknown) => cause);
    expect(failed).toMatchObject({ cleanupIncomplete: true });
    denied = false;
    await provider.close();
    expect(result.error).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    expect(failed).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
  } finally {
    denied = false;
    await provider.close();
  }
});

it("retries all opening leases after a refusal and reports only those still owned", async () => {
  const firstFailure = new Error("first release denied");
  const secondFailure = new Error("second release denied");
  const first = controlledCleanup({ refused: true, failure: firstFailure });
  const second = controlledCleanup({ refused: true, failure: secondFailure });
  const primary = new AnalysisOutputError(
    "capture_browser_scenario",
    "authored open failure",
  );
  const provider = new PlaywrightBrowserScenarioProvider(
    async (_scenario, options) => {
      options.retainCleanup?.(
        new AnalysisCleanupLease(first.close, ["first cleanup"]),
      );
      options.retainCleanup?.(
        new AnalysisCleanupLease(second.close, ["second cleanup"]),
      );
      throw primary;
    },
  );
  try {
    const result = await provider.captureScenario(scenario());
    if (result.ok) throw new Error("Expected opening failure");
    const both: unknown = await provider
      .close()
      .catch((cause: unknown) => cause);
    expect(both).toBeInstanceOf(ProviderCleanupError);
    expect(both).toMatchObject({
      operation: "capture_browser_scenario",
      cleanupIncomplete: true,
      cleanupResources: ["first cleanup", "second cleanup"],
      cause: { errors: [{ cause: firstFailure }, { cause: secondFailure }] },
    });
    second.allow();
    const remaining: unknown = await provider
      .close()
      .catch((cause: unknown) => cause);
    for (const failure of [result.error, both, remaining])
      expect(failure).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: ["first cleanup"],
      });
    expect([first.attempts, second.attempts]).toEqual([2, 2]);

    first.allow();
    await provider.close();
    for (const failure of [result.error, both, remaining])
      expect(failure).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
    expect(result.error.cleanupPrimary).toBe(primary);
    expect([first.attempts, second.attempts]).toEqual([3, 2]);
  } finally {
    first.allow();
    second.allow();
    await provider.close();
  }
});

it("keeps a cancelled opening incomplete until its retained late cleanup finishes", async () => {
  const late = phaseGate();
  const reason = { caller: "cancelled opening before late handshake" };
  const primary = new AnalysisCancelledError("capture_browser_scenario", {
    cause: reason,
  });
  const provider = new PlaywrightBrowserScenarioProvider(
    async (_scenario, options) => {
      options.retainCleanup?.(
        new AnalysisCleanupLease(() => late.hold(), ["late opening"]),
      );
      throw primary;
    },
  );
  try {
    const result = await provider.captureScenario(scenario());
    if (result.ok) throw new Error("Expected cancelled opening");
    expect(result.error.cleanupIncomplete).toBe(true);
    const closing = provider.close();
    await late.reached(closing, "late opening release");
    expect(result.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["late opening"],
    });
    late.release();
    await closing;
    expect(result.error).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    expect(result.error.cleanupPrimary).toBe(primary);
    expect(primary.cause).toBe(reason);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cancelled",
    });
  } finally {
    late.release();
    await provider.close();
  }
});

it.each([false, true])(
  "follows late browser acknowledgement without another retry (cancelled during close: %s)",
  async (cancelled) => {
    vi.useFakeTimers();
    let acknowledge: () => void = () => {};
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const caller = new AbortController();
    const reason = { caller: "during final browser close" };
    const owner = new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser: (disconnectAtBoundary) =>
        disconnectAtBoundary(() => acknowledgement),
      removeProfile: undefined,
    });
    const session = new FakeSession("launch");
    session.cleanupLease = owner.cleanupLease;
    session.close = async () => {
      if (cancelled) caller.abort(reason);
      await owner.close();
      return "terminated-owned-process";
    };
    const provider = new PlaywrightBrowserScenarioProvider(async () => session);
    try {
      const pending = provider.captureScenario(scenario(), {
        signal: caller.signal,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      if (result.ok) throw new Error("Expected timed out cleanup response");
      expect(result.error.cleanupIncomplete).toBe(true);
      const partial = result.error.partialObservation;
      acknowledge();
      await owner.cleanupLease.release();
      expect(result.error).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
      expect(result.error.partialObservation).toBe(partial);
      if (cancelled) {
        expect(projectAnalysisError(result.error)).toMatchObject({
          code: "cancelled",
        });
        expect(primaryAnalysisError(result.error).cause).toBe(reason);
      }
    } finally {
      acknowledge();
      await provider.close();
      vi.useRealTimers();
    }
  },
);

it("retains a profile-only opening lease without adding transport labels or waiting for another retry", async () => {
  let denied = true;
  let releases = 0;
  const primary = new AnalysisOutputError(
    "capture_browser_scenario",
    "authored opening failure",
  );
  const lease = new AnalysisCleanupLease(async () => {
    releases++;
    if (denied) throw new Error("profile removal denied");
  }, ["browser_profile"]);
  const provider = new PlaywrightBrowserScenarioProvider(
    async (_scenario, options) => {
      try {
        return await failBrowserScenarioOperation(lease, primary);
      } catch (cause: unknown) {
        options.retainCleanup?.(lease);
        throw cause;
      }
    },
  );
  try {
    const result = await provider.captureScenario(scenario());
    if (result.ok) throw new Error("Expected opening failure");
    expect(result.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["browser_profile"],
    });
    denied = false;
    await lease.release();
    expect(result.error).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "unreadable_output",
    });
    await provider.close();
    expect(releases).toBe(2);
  } finally {
    denied = false;
    await provider.close();
  }
});

it("keeps an earlier physical failure primary when final cleanup also observes cancellation", async () => {
  const caller = new AbortController();
  const physical = new Error("physical capture failure");
  const primary = new AnalysisOutputError(
    "capture_browser_scenario",
    physical.message,
    { cause: physical },
  );
  const session = new FakeSession("launch", {
    capture: { call: 1, error: primary },
  });
  let denied = true;
  session.close = async () => {
    caller.abort({ caller: "later during final cleanup" });
    if (denied) throw new Error("cleanup denied");
    return "terminated-owned-process";
  };
  const provider = new PlaywrightBrowserScenarioProvider(async () => session);
  try {
    const result = await provider.captureScenario(scenario(), {
      signal: caller.signal,
    });
    if (result.ok) throw new Error("Expected physical failure");
    denied = false;
    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "unreadable_output",
    });
    expect(primaryAnalysisError(result.error)).toBe(primary);
    expect(primary.cause).toBe(physical);
  } finally {
    denied = false;
    await provider.close();
  }
});

it.each([
  { cleanupFailure: false, finalized: true },
  { cleanupFailure: true, finalized: false },
  { cleanupFailure: true, finalized: true },
])(
  "keeps planned secret screenshots unavailable (cleanup failure: $cleanupFailure, finalized: $finalized)",
  async ({ cleanupFailure, finalized }) => {
    const input = browserScenarioSchema.parse({
      ...scenario({ captures: ["screenshot"] }),
      actions: [
        {
          step_id: "request",
          action: "request",
          method: "POST",
          path: "/api/items",
          save: [{ name: "token", json_pointer: "/token", secret: true }],
        },
      ],
    });
    const secrets = resolveScenarioSecrets(input, {});
    const screenshot = vi.fn(async () =>
      Buffer.from("private screenshot pixels"),
    );
    const session = new FakeSession(
      "launch",
      cleanupFailure ? { close: new Error("cleanup failed") } : {},
    );
    session.captureFinalized = () => finalized;
    session.capture = async (requested) =>
      capturePlaywrightStepArtifacts({
        context: {} as BrowserContext,
        page: { screenshot } as unknown as Page,
        secrets,
        requested,
      });
    session.onPerform = () =>
      secrets.save("request.token", "token", "late-pixel-token", true);
    const provider = new PlaywrightBrowserScenarioProvider(async () => session);
    const result = await provider.captureScenario(input);
    const step = {
      artifacts: { screenshot: { state: "missing" } },
      completeness: {
        equality_eligible: false,
        missing_sections: ["screenshot"],
      },
    };
    if (cleanupFailure && !finalized)
      expect(result).toMatchObject({
        ok: false,
        error: { partialObservation: { capture: { steps: [step, step] } } },
      });
    else {
      if (!result.ok) throw result.error;
      expect(result.value.steps).toMatchObject([step, step]);
      expect(result.value.completeness.equality_eligible).toBe(false);
    }
    expect(screenshot).not.toHaveBeenCalled();
  },
);

it.each(["clean", "pending", "queued"] as const)(
  "refuses scenario admission during %s shutdown without claiming cleanup failed",
  async (stage) => {
    let opened = 0;
    const finalization = phaseGate();
    const session = new FakeSession("launch");
    session.close = async () => {
      await finalization.hold();
      return "terminated-owned-process";
    };
    const provider = new PlaywrightBrowserScenarioProvider(async () => {
      opened += 1;
      return session;
    });
    let running: ReturnType<typeof provider.captureScenario> | undefined;
    let closing: Promise<void> | undefined;
    try {
      if (stage !== "clean") {
        running = provider.captureScenario(scenario());
        await finalization.reached(running, "scenario finalization");
      }
      const queued =
        stage === "queued" ? provider.captureScenario(scenario()) : undefined;
      closing = provider.close();
      if (stage === "clean") await closing;
      else {
        const onClose = vi.fn();
        void closing.then(onClose, onClose);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(onClose).not.toHaveBeenCalled();
      }
      const refusal = queued ?? provider.captureScenario(scenario());
      if (stage === "queued") finalization.release();
      const result = await refusal;
      expect(result.ok).toBe(false);
      if (result.ok)
        throw new Error("Expected closed provider admission refusal");
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "capability_unavailable",
        details: { operation: "capture_browser_scenario" },
      });
      expect(opened).toBe(stage === "clean" ? 0 : 1);
      finalization.release();
      if (running !== undefined)
        await expect(running).resolves.toMatchObject({ ok: true });
    } finally {
      finalization.release();
      await running;
      await closing;
      await provider.close();
    }
  },
);

it("reports a browser open failure whose cleanup already released as that failure alone", async () => {
  const primary = new ProviderAdapterError("playwright", "browser_open", {
    diagnostics: { reason: "launch refused" },
  });
  let opens = 0;
  let release = true;
  const provider = new PlaywrightBrowserScenarioProvider(
    async (_scenario, options) => {
      opens += 1;
      const lease = new AnalysisCleanupLease(async () => {
        if (!release) throw new Error("profile still busy");
      }, ["browser profile"]);
      options.retainCleanup?.(lease);
      await lease.release().catch(() => undefined);
      throw primary;
    },
  );
  const clean = await provider.captureScenario(scenario());
  expect(clean).toEqual({ ok: false, error: primary });
  // Nothing was retained, so the next capture is admitted.
  release = false;
  const retained = await provider.captureScenario(scenario());
  if (retained.ok) throw new Error("Expected retained cleanup");
  expect(retained.error.cleanupIncomplete).toBe(true);
  expect(opens).toBe(2);
  release = true;
  await provider.close();
});
