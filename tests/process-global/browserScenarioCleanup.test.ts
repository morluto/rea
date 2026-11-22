import { createCommandCli } from "../support/cli/commandCli.js";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";

import type { BrowserScenarioCapturePort } from "../../src/ports/BrowserScenarioCapturePort.js";
import { createBrowserScenarioEvidence } from "../../src/application/BrowserScenarioEvidence.js";
import type {
  BrowserScenarioSessionOpener,
  BrowserScenarioSessionPort,
} from "../../src/browser/BrowserScenarioSessionPort.js";
import { PlaywrightBrowserScenarioProvider } from "../../src/browser/PlaywrightBrowserScenarioProvider.js";
import { PlaywrightScenarioSession } from "../../src/browser/PlaywrightScenarioSession.js";
import { PlaywrightScenarioBrowserCleanupOwner } from "../../src/browser/PlaywrightScenarioBrowser.js";
import { registerBrowserScenarioCommands } from "../../src/cliBrowserScenarioCommands.js";
import { sanitizeBrowserUrl } from "../../src/domain/browserObservation.js";
import {
  browserScenarioSchema,
  type BrowserScenario,
} from "../../src/domain/browserScenario.js";
import type { BrowserScenarioAction } from "../../src/domain/browserScenarioValues.js";
import { browserStepArtifactsSchema } from "../../src/domain/browserScenarioCaptureValues.js";
import { silentLogger } from "../../src/logger.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../../src/domain/analysisErrorCore.js";
import { BrowserObservationError } from "../../src/domain/browserObservationError.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
} from "../../src/domain/jsonValue.js";
import { ok } from "../../src/domain/result.js";
import { phaseGate } from "../support/lifecycleHarness.js";
import { primaryAnalysisError } from "../../src/domain/analysisErrorBase.js";

const state = vi.hoisted(() => ({
  provider: undefined as BrowserScenarioCapturePort | undefined,
  launchPersistentContext: vi.fn(),
}));
vi.mock("playwright-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("playwright-core")>();
  return {
    ...actual,
    chromium: {
      ...actual.chromium,
      launchPersistentContext: state.launchPersistentContext,
    },
  };
});
vi.mock("../../src/composition/browserScenario.js", () => ({
  createBrowserScenarioProvider: () => state.provider,
}));

const scenario = browserScenarioSchema.parse({
  browser: { mode: "launch", executable_path: resolve("/fixture/chromium") },
  start_url: { url: "https://app.example.test/" },
  actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  storage: {},
  capture: { after_each_step: ["url"], at_end: [], events: [] },
});

// Controlled session failures exercise the real provider and cleanup owner;
// this fixture opens no browser process or profile directory.
class RetrySession implements BrowserScenarioSessionPort {
  readonly mode = "launch";
  readonly processOwnership = "provider-owned";
  readonly product = "Fixture Chromium";
  readonly version = "1";
  readonly initialUrl = "https://app.example.test/";
  closeBrowserCalls = 0;
  profileRemovalCalls = 0;
  readonly cleanup = new PlaywrightScenarioBrowserCleanupOwner({
    closeBrowser: async () => {
      this.closeBrowserCalls += 1;
      if (this.closeBrowserCalls <= this.closeFailures)
        throw new Error(`injected close failure ${this.closeBrowserCalls}`);
    },
    removeProfile: async () => {
      expect(this.cleanup.browserClosed).toBe(true);
      this.profileRemovalCalls += 1;
    },
  });

  get cleanupLease() {
    return this.cleanup.cleanupLease;
  }
  constructor(private readonly closeFailures = 1) {}

  currentUrl() {
    return this.initialUrl;
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
  events() {
    return {
      retained: 0,
      dropped: 0,
      items: [],
      omissions: {
        by_kind: [],
        network_transactions: [],
        network_transaction_range: null,
      },
    };
  }
  async perform(_action: BrowserScenarioAction) {}
  async capture(
    requested: ReadonlySet<
      BrowserScenario["capture"]["after_each_step"][number]
    >,
  ) {
    const artifact = (
      kind: BrowserScenario["capture"]["after_each_step"][number],
    ) =>
      !requested.has(kind)
        ? { state: "not_requested" }
        : kind === "url"
          ? { state: "captured", value: this.sanitizeUrl(this.initialUrl) }
          : { state: "missing", reason: "fixture unavailable" };
    return browserStepArtifactsSchema.parse({
      screenshot: artifact("screenshot"),
      dom: artifact("dom"),
      accessibility: artifact("accessibility"),
      url: artifact("url"),
      history: artifact("history"),
      storage: artifact("storage"),
    });
  }
  async close() {
    await this.cleanup.close();
    return "terminated-owned-process" as const;
  }
  redactError(error: unknown) {
    return error instanceof Error ? error.message : "fixture failure";
  }
}

const serveScenario = async () => {
  const cli = createCommandCli();
  registerBrowserScenarioCommands(cli, silentLogger, {});
  let stdout = "";
  let exitCode = 0;
  await cli.serve(
    ["capture-browser-scenario", JSON.stringify(scenario), "--json"],
    {
      env: {},
      exit: (code) => {
        exitCode = code;
      },
      stdout: (text) => {
        stdout += text;
      },
    },
  );
  return {
    output: jsonObjectSchema.parse(JSON.parse(stdout)),
    exitCode,
    processExitCode: process.exitCode,
  };
};

it.each([false, true])(
  "preserves the initial capture when the one-shot CLI retries close (retry refused: %s)",
  async (retryRefused) => {
    const savedExitCode = process.exitCode;
    const session = new RetrySession(retryRefused ? 2 : 1);
    const provider = new PlaywrightBrowserScenarioProvider(async () => session);
    const close = vi.spyOn(provider, "close");
    state.provider = provider;
    try {
      const result = await serveScenario();
      expect(result.processExitCode).toBe(1);
      expect(result.output).toMatchObject({
        code: "cleanup_incomplete",
        category: "execution_failure",
        details: {
          cleanup: "incomplete",
          resources: ["browser_transport", "browser_profile"],
          partial_observation: {
            capture: {
              browser: { cleanup: "incomplete" },
              steps: [{ step_id: "scenario_start" }, { step_id: "wait" }],
            },
          },
        },
      });
      expect(close).toHaveBeenCalledOnce();
      expect(session.closeBrowserCalls).toBe(2);
      expect(session.profileRemovalCalls).toBe(retryRefused ? 0 : 1);
      if (retryRefused) {
        expect(result.output).toMatchObject({
          details: {
            diagnostics: {
              primary_error: {
                details: {
                  diagnostics: {
                    primary_error: {
                      details: { cleanup_reason: "injected close failure 1" },
                    },
                  },
                },
              },
              cleanup_error: {
                details: {
                  diagnostics: { reason: "injected close failure 2" },
                },
              },
            },
          },
        });
        await provider.close();
        expect(session.closeBrowserCalls).toBe(3);
        expect(session.profileRemovalCalls).toBe(1);
      }
    } finally {
      try {
        await provider.close();
      } finally {
        state.provider = undefined;
        process.exitCode = savedExitCode;
      }
    }
  },
);

it("retries a late Playwright open after cancellation before accepting another capture", async () => {
  const launch = phaseGate<void, EventEmitter>();
  const closing = phaseGate();
  const order: string[] = [];
  let firstCloseAttempts = 0;
  const makeContext = (close = async () => {}) => {
    const page = Object.assign(new EventEmitter(), {
      url: () => "https://app.example.test/",
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
    });
    const browser = { version: () => "Fixture Chromium" };
    return Object.assign(new EventEmitter(), {
      setDefaultTimeout: () => undefined,
      setDefaultNavigationTimeout: () => undefined,
      addCookies: async () => undefined,
      browser: () => browser,
      pages: () => [page],
      close,
    });
  };
  const lateContext = makeContext(async () => {
    firstCloseAttempts += 1;
    if (firstCloseAttempts === 1) {
      await closing.hold();
      throw new Error("injected late browser close failure");
    }
    order.push("prior context closed");
  });
  state.launchPersistentContext
    .mockImplementationOnce(() => launch.hold())
    .mockImplementation(async () => {
      order.push("next launch");
      return makeContext();
    });
  const openSession = vi.fn<BrowserScenarioSessionOpener>((input, options) =>
    PlaywrightScenarioSession.open(input, {}, options),
  );
  const provider = new PlaywrightBrowserScenarioProvider(openSession);
  const cancellation = new AbortController();
  const first = provider.captureScenario(scenario, {
    signal: cancellation.signal,
  });
  try {
    await launch.reached(first, "first browser launch");
    cancellation.abort();
    const cancelled = await first;
    if (cancelled.ok) throw new Error("Expected first capture cancellation");
    expect(cancelled.error.cleanupIncomplete).toBe(true);
    const primary = primaryAnalysisError(cancelled.error);
    expect(primary).toBeInstanceOf(AnalysisCancelledError);
    expect(primary.cause).toBe(cancellation.signal.reason);

    launch.release(lateContext);
    const next = provider.captureScenario(scenario);
    await closing.reached(next, "late browser close");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(openSession).toHaveBeenCalledOnce();
    expect(cancelled.error.cleanupIncomplete).toBe(true);
    closing.release();

    const retried = await next;
    if (!retried.ok) throw retried.error;
    expect(retried.value.steps).toHaveLength(2);
    expect(firstCloseAttempts).toBe(2);
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(cancelled.error).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    expect(order).toEqual(["prior context closed", "next launch"]);
  } finally {
    cancellation.abort();
    launch.release(lateContext);
    closing.release();
    try {
      await provider.close();
    } finally {
      state.launchPersistentContext.mockReset();
    }
  }
});

it("retains completed Evidence when provider shutdown fails after a successful capture", async () => {
  const savedExitCode = process.exitCode;
  const provider = new PlaywrightBrowserScenarioProvider(
    async () => new RetrySession(0),
  );
  const captured = await provider.captureScenario(scenario);
  if (!captured.ok) throw captured.error;
  const evidence = createBrowserScenarioEvidence(
    scenario,
    { source: jsonValueSchema.parse(captured.value), facts: captured.value },
    provider.identity(),
  );
  const close = vi.fn().mockRejectedValue(
    new BrowserObservationError("capture_browser_scenario", "cleanup_failed", {
      cleanup: {
        reason: "injected shutdown failure",
        resources: ["browser_profile"],
      },
    }),
  );
  state.provider = {
    identity: () => provider.identity(),
    captureScenario: async () => ok(captured.value),
    close,
  };
  try {
    const result = await serveScenario();
    expect(result.processExitCode).toBe(1);
    expect(result.output).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: ["browser_profile"] },
    });
    const details = jsonObjectSchema.parse(result.output.details);
    expect(parseEvidence(details.partial_observation)).toEqual(evidence);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await provider.close();
    state.provider = undefined;
    process.exitCode = savedExitCode;
  }
});

it("preserves cancellation diagnostics while retrying retained cleanup", async () => {
  const savedExitCode = process.exitCode;
  const session = new RetrySession();
  vi.spyOn(session, "capture").mockRejectedValue(
    new AnalysisCancelledError("capture_browser_scenario"),
  );
  const provider = new PlaywrightBrowserScenarioProvider(async () => session);
  state.provider = provider;
  try {
    const result = await serveScenario();
    expect(result.output).toMatchObject({
      code: "cleanup_incomplete",
      category: "cancelled",
      details: {
        cleanup: "incomplete",
        diagnostics: {
          primary_error: {
            code: "cleanup_incomplete",
            details: {
              diagnostics: {
                primary_error: { code: "cancelled", category: "cancelled" },
              },
            },
          },
        },
        partial_observation: { kind: "browser-scenario-observation" },
      },
    });
    expect(session.closeBrowserCalls).toBe(2);
    expect(session.profileRemovalCalls).toBe(1);
  } finally {
    await provider.close();
    state.provider = undefined;
    process.exitCode = savedExitCode;
  }
});

it("preserves a thrown capture error when provider shutdown also rejects", async () => {
  const savedExitCode = process.exitCode;
  const provider = new PlaywrightBrowserScenarioProvider(
    async () => new RetrySession(0),
  );
  const primary = new AnalysisTimeoutError("capture_browser_scenario", 123);
  const close = vi
    .fn()
    .mockRejectedValue(new Error("secondary shutdown failure"));
  state.provider = {
    identity: () => provider.identity(),
    captureScenario: async () => {
      throw primary;
    },
    close,
  };
  try {
    const result = await serveScenario();
    expect(result.output).toMatchObject({
      code: "cleanup_incomplete",
      category: "timeout",
      details: {
        execution_failure: "provider_timeout",
        diagnostics: {
          primary_error: { code: "provider_timeout", category: "timeout" },
          cleanup_error: {
            details: { diagnostics: { reason: "secondary shutdown failure" } },
          },
        },
      },
    });
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await provider.close();
    state.provider = undefined;
    process.exitCode = savedExitCode;
  }
});
