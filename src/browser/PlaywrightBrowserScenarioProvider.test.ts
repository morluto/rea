import { describe, expect, it } from "vitest";

import type { BrowserScenarioSessionPort } from "./BrowserScenarioSessionPort.js";
import { PlaywrightBrowserScenarioProvider } from "./PlaywrightBrowserScenarioProvider.js";
import { BrowserScenarioCaptureBudget } from "./PlaywrightScenarioArtifacts.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import {
  browserScenarioSchema,
  type BrowserScenario,
  type BrowserScenarioAction,
} from "../domain/browserScenario.js";
import {
  browserStepArtifactsSchema,
  type BrowserScenarioEvent,
  type BrowserStepArtifacts,
} from "../domain/browserScenarioCapture.js";

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
    schema_version: 1,
    browser:
      options.mode === "connect"
        ? {
            mode: "connect",
            cdp_endpoint: "http://127.0.0.1:9222",
            target_id: "page-1",
            ownership: "external",
            cleanup: "disconnect-only",
          }
        : {
            mode: "launch",
            executable_path: "/opt/chromium",
            headless: true,
            user_data: "temporary-owned",
            cleanup: "close-and-delete-profile",
          },
    start_url: { url: "https://app.example.test/" },
    allowed_origins: ["https://app.example.test"],
    environment: {
      viewport: { width: 1_280, height: 720 },
      locale: "en-US",
      timezone: "UTC",
      color_scheme: "light",
      reduced_motion: "reduce",
      service_workers: "block",
    },
    actions: Array.from({ length: options.actions ?? 1 }, (_, index) => ({
      step_id: `wait_${index}`,
      action: "wait_for_timeout",
      duration_ms: 1,
    })),
    storage: {},
    request_replay: { mode: "disabled" },
    secrets: [],
    redaction: {
      secret_values: "replace-with-secret-reference",
      query_parameter_names: [],
    },
    capture: {
      after_each_step: options.captures ?? ["url"],
      at_end: [],
      events: options.events ?? [],
    },
    limits: {
      max_duration_ms: 10_000,
      action_timeout_ms: 1_000,
      navigation_timeout_ms: 1_000,
      max_events: 100,
      max_frames: 10,
      max_workers: 10,
      max_popups: 10,
      max_websockets: 10,
      max_dom_nodes: 100,
      max_accessibility_nodes: 100,
      max_screenshots: 2,
      max_screenshot_bytes: 1_024,
      max_storage_entries: 10,
      max_total_metadata_bytes: 16_384,
    },
    approved: true,
  });

type SnapshotKind = BrowserScenario["capture"]["after_each_step"][number];

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
  eventTruncations: (
    | "events"
    | "frames"
    | "workers"
    | "popups"
    | "websockets"
  )[] = [];
  onPerform: (() => void) | undefined;
  private step = 0;

  constructor(
    readonly mode: "launch" | "connect",
    private readonly incomplete = false,
    private readonly failAction = false,
    private readonly failCapture = false,
  ) {
    this.processOwnership = mode === "launch" ? "provider-owned" : "external";
  }

  currentUrl() {
    return "https://app.example.test/current";
  }

  setStep(index: number) {
    this.step = index;
  }

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
    return { retained: 0, dropped: 0, items: [] };
  }

  eventTruncationSections() {
    return this.eventTruncations;
  }

  async perform(
    _action: BrowserScenarioAction,
    _timeout: number,
    signal?: AbortSignal,
  ) {
    this.performCalls += 1;
    this.onPerform?.();
    if (signal?.aborted === true) throw new Error("request cancelled");
    if (this.failAction) throw new Error("fixture secret action failure");
  }

  capture(
    requested: ReadonlySet<SnapshotKind>,
    _budget: BrowserScenarioCaptureBudget,
  ): Promise<BrowserStepArtifacts> {
    this.captureCalls += 1;
    if (this.failCapture) return Promise.reject(new Error("capture failed"));
    return Promise.resolve(
      browserStepArtifactsSchema.parse({
        screenshot: artifactState("screenshot", requested, this.incomplete),
        dom: artifactState("dom", requested, this.incomplete),
        accessibility: artifactState(
          "accessibility",
          requested,
          this.incomplete,
        ),
        url: artifactState("url", requested, this.incomplete),
        history: artifactState("history", requested, this.incomplete),
        storage: artifactState("storage", requested, this.incomplete),
      }),
    );
  }

  close() {
    this.closeCalls += 1;
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
  it("captures initial and action steps and closes its launched session", async () => {
    const session = new FakeSession("launch");
    const provider = new PlaywrightBrowserScenarioProvider({
      open: () => Promise.resolve(session),
    });
    const result = await provider.captureScenario(scenario());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps.map(({ step_index }) => step_index)).toEqual([
      0, 1,
    ]);
    expect(result.value.browser).toMatchObject({
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
    });
    expect(result.value.completeness).toMatchObject({
      status: "complete",
      equality_eligible: true,
    });
    expect(session.closeCalls).toBe(1);
  });

  it("makes missing and truncated captures ineligible for equality", async () => {
    const session = new FakeSession("launch", true);
    const provider = new PlaywrightBrowserScenarioProvider({
      open: () => Promise.resolve(session),
    });
    const result = await provider.captureScenario(
      scenario({ captures: ["screenshot", "dom"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.completeness).toMatchObject({
      status: "truncated",
      equality_eligible: false,
      missing_sections: ["dom"],
      truncated_sections: ["screenshot"],
    });
  });

  it("makes event limit truncation ineligible for equality", async () => {
    const session = new FakeSession("launch");
    session.eventTruncations = ["events", "websockets"];
    const provider = new PlaywrightBrowserScenarioProvider({
      open: () => Promise.resolve(session),
    });
    const result = await provider.captureScenario(
      scenario({ events: ["websockets"] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.completeness).toMatchObject({
      status: "truncated",
      equality_eligible: false,
      truncated_sections: ["events", "websockets"],
    });
  });

  it("records one failed step, cancels later actions, and still cleans up", async () => {
    const session = new FakeSession("launch", false, true);
    const provider = new PlaywrightBrowserScenarioProvider({
      open: () => Promise.resolve(session),
    });
    const result = await provider.captureScenario(scenario({ actions: 2 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
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
    const provider = new PlaywrightBrowserScenarioProvider({
      open: () => Promise.resolve(session),
    });
    const result = await provider.captureScenario(
      scenario({ mode: "connect" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
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

  it("closes the session when initial capture fails", async () => {
    const session = new FakeSession("launch", false, false, true);
    const provider = new PlaywrightBrowserScenarioProvider({
      open: () => Promise.resolve(session),
    });
    const result = await provider.captureScenario(scenario());
    expect(result.ok).toBe(false);
    expect(session.closeCalls).toBe(1);
  });

  it("does not open a session for an already-cancelled request", async () => {
    let opens = 0;
    const provider = new PlaywrightBrowserScenarioProvider({
      open: () => {
        opens += 1;
        return Promise.resolve(new FakeSession("launch"));
      },
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
    const provider = new PlaywrightBrowserScenarioProvider({
      open: () => Promise.resolve(session),
    });
    const result = await provider.captureScenario(scenario(), {
      signal: controller.signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps[1]?.status).toBe("cancelled");
    expect(session.closeCalls).toBe(1);
  });
});

describe("BrowserScenarioCaptureBudget", () => {
  it("enforces cumulative screenshot and metadata limits", () => {
    const budget = new BrowserScenarioCaptureBudget(1, 10);
    expect(budget.claimScreenshot()).toBe(true);
    expect(budget.claimScreenshot()).toBe(false);
    expect(budget.claimMetadata(6)).toBe(true);
    expect(budget.claimMetadata(5)).toBe(false);
    expect(budget.claimMetadata(4)).toBe(true);
  });
});
