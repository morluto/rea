import { getEventListeners } from "node:events";
import { MAX_NODE_TIMER_DELAY_MS } from "../../../src/domain/analysisResourceLimits.js";
import { createServer, type Socket } from "node:net";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { openCdpEndpoint } from "../../../src/browser/CdpTargetSession.js";
import {
  PlaywrightScenarioServiceWorkers,
  SERVICE_WORKER_POLICY_CHECK_TIMEOUT_MS,
} from "../../../src/browser/PlaywrightScenarioServiceWorkers.js";
import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { CdpWebRuntimeProvider } from "../../../src/browser/execution/CdpWebRuntimeProvider.js";
import { CDP_DISCOVERY_RESPONSE_TIMEOUT_MS } from "../../../src/domain/browserDeadline.js";
import { BrowserObservationError } from "../../../src/domain/browserObservationError.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  browserObservationEndpointSchema,
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../../../src/domain/browserObservation.js";
import { observeWebExecutionInputSchema } from "../../../src/domain/webExecution.js";
import { WEB_RUNTIME_LIMITS } from "../../../src/domain/webRuntime.js";
import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { startRuntimeBrowser } from "../../fixtures/webRuntime.js";
import { startFakeV8Inspector } from "../../fixtures/inspector/fakeV8Inspector.js";
import { phaseGate } from "../../support/lifecycleHarness.js";
import { waitFor } from "../../support/testWait.js";

// Keep real socket scheduling; expire only a timer whose owning phase is ready.
beforeEach(() => {
  vi.spyOn(globalThis, "setTimeout");
  vi.spyOn(globalThis, "clearTimeout");
});

afterEach(() => vi.restoreAllMocks());

const activeTimers = (milliseconds: number) => {
  const scheduled = vi.mocked(globalThis.setTimeout);
  const cleared = vi.mocked(globalThis.clearTimeout);
  return scheduled.mock.calls.flatMap(([callback, delay], index) => {
    const result = scheduled.mock.results[index];
    if (
      delay !== milliseconds ||
      result?.type !== "return" ||
      cleared.mock.calls.some(([timer]) => timer === result.value)
    )
      return [];
    return [{ callback, timer: result.value }];
  });
};

const expireTimer = (milliseconds: number): void => {
  const timers = activeTimers(milliseconds);
  expect(timers).toHaveLength(1);
  const timer = timers[0];
  if (timer === undefined) throw new Error("Expected one active timer");
  try {
    timer.callback();
  } finally {
    // The observation callback resolves naturally without cancelling its timer.
    clearTimeout(timer.timer);
  }
};

const expireEveryTimer = (milliseconds: number): void => {
  const timers = activeTimers(milliseconds);
  expect(timers.length).toBeGreaterThan(0);
  for (const timer of timers) {
    timer.callback();
    clearTimeout(timer.timer);
  }
};

const startStalledHandshake = async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP address");
  return {
    sockets,
    url: (path: string) => `ws://127.0.0.1:${String(address.port)}${path}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

it.each([
  {
    label: "default",
    selected: undefined,
    effective: WEB_RUNTIME_LIMITS.commandTimeoutMs,
  },
  { label: "selected", selected: 1_500, effective: 1_500 },
])(
  "times out a stalled handshake on the $label command deadline and releases its socket",
  async ({ selected, effective }) => {
    const server = await startStalledHandshake();
    const controller = new AbortController();
    try {
      const rejection = expect(
        CdpConnection.connect(
          server.url("/target"),
          "inspect_web_page",
          controller.signal,
          selected === undefined ? undefined : { commandTimeoutMs: selected },
        ),
      ).rejects.toMatchObject({
        reason: "timeout",
        userMessage: expect.stringContaining(
          `CDP WebSocket handshake exceeded its ${String(effective)} ms command_timeout_ms`,
        ),
      });
      await waitFor(() => expect(server.sockets.size).toBe(1));
      expireTimer(effective);
      await rejection;
      await waitFor(() => expect(server.sockets.size).toBe(0));
    } finally {
      controller.abort();
      await server.close();
    }
  },
);

it.each([
  { hangOnMethod: "Target.attachToTarget", timeoutMs: undefined },
  { hangOnMethod: "Page.enable", timeoutMs: 1_500 },
  { hangOnMethod: "Runtime.enable", timeoutMs: undefined },
])(
  "times out $hangOnMethod after HTTP discovery and closes the target session",
  async ({ hangOnMethod, timeoutMs }) => {
    const browser = await startFakeCdpBrowser({ hangOnMethod });
    try {
      const pending = new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          observation_ms: 0,
          ...(timeoutMs === undefined ? {} : { command_timeout_ms: timeoutMs }),
        }),
        { signal: AbortSignal.timeout(10_000) },
      );
      await waitFor(() =>
        expect(browser.commands.map(({ method }) => method)).toContain(
          hangOnMethod,
        ),
      );
      expireTimer(timeoutMs ?? WEB_RUNTIME_LIMITS.commandTimeoutMs);
      const result = await pending;
      if (result.ok) throw new Error("Expected a target command timeout");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "provider_timeout",
        category: "timeout",
      });
      if (timeoutMs !== undefined)
        expect(result.error.userMessage).toContain(
          "1500 ms command_timeout_ms",
        );
      await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    } finally {
      await browser.close();
    }
  },
);

it("ignores a late timed-out reply and keeps following commands correlated", async () => {
  const browser = await startFakeCdpBrowser({
    hangOnMethod: "Storage.getStorageKey",
  });
  const connection = await CdpConnection.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
  );
  try {
    const rejection = expect(
      connection.send(
        "Storage.getStorageKey",
        {},
        undefined,
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
    await waitFor(() => expect(browser.commands).toHaveLength(1));
    expireTimer(WEB_RUNTIME_LIMITS.commandTimeoutMs);
    await rejection;
    const next = expect(
      connection.send("Storage.getStorageKey"),
    ).resolves.toEqual({
      storageKey: "following",
    });
    await waitFor(() => expect(browser.commands).toHaveLength(2));
    const [expired, following] = browser.commands;
    if (expired === undefined || following === undefined)
      throw new Error("Expected both commands");
    browser.emitRawMessage(JSON.stringify({ id: expired.id, result: [] }));
    browser.emitRawMessage(
      JSON.stringify({
        id: following.id,
        result: { storageKey: "following" },
      }),
    );
    await next;
  } finally {
    await connection.close();
    await browser.close();
  }
});

it.each(["success", "rejection", "abort", "disconnect"])(
  "releases handshake and command timers on %s",
  async (outcome) => {
    const browser = await startFakeCdpBrowser({
      ...(outcome === "abort" || outcome === "success"
        ? { hangOnMethod: "Runtime.enable" }
        : {}),
      ...(outcome === "disconnect" ? { closeOnMethod: "Runtime.enable" } : {}),
    });
    const controller = new AbortController();
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "inspect_web_page",
      controller.signal,
    );
    try {
      const pending = connection.send(
        outcome === "rejection" ? "Storage.getStorageKey" : "Runtime.enable",
        {},
        undefined,
        controller.signal,
      );
      const assertion =
        outcome === "success"
          ? expect(pending).resolves.toEqual({})
          : expect(pending).rejects.toMatchObject({
              _tag:
                outcome === "abort"
                  ? "AnalysisCancelledError"
                  : "BrowserObservationError",
            });
      if (outcome === "success") {
        await waitFor(() => expect(browser.commands).toHaveLength(1));
        const command = browser.commands[0];
        if (command === undefined)
          throw new Error("Expected a pending command");
        browser.emitRawMessage(JSON.stringify({ id: command.id, result: {} }));
      }
      if (outcome === "abort") controller.abort();
      await assertion;
      expect(activeTimers(WEB_RUNTIME_LIMITS.commandTimeoutMs)).toHaveLength(0);
      expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    } finally {
      await connection.close();
      await browser.close();
    }
  },
);

it.each(["Runtime.enable", "Debugger.enable"])(
  "times out Inspector %s and preserves observations received before expiry",
  async (hangOnMethod) => {
    const inspector = await startFakeV8Inspector({
      targetUrl: "https://fixture.example/app.js",
      hangOnMethod,
    });
    try {
      const pending = new V8InspectorProvider().observe(
        {
          inspector_endpoint: inspector.endpoint,
          target_id: inspector.targetId,
          observation_ms: 0,
        },
        { signal: AbortSignal.timeout(10_000) },
      );
      await waitFor(() =>
        expect(inspector.commands.map(({ method }) => method)).toContain(
          hangOnMethod,
        ),
      );
      expireTimer(WEB_RUNTIME_LIMITS.commandTimeoutMs);
      const result = await pending;
      if (result.ok) throw new Error("Expected an Inspector command timeout");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "provider_timeout",
        category: "timeout",
      });
      expect(result.error.partialObservation).toMatchObject({
        capture: {
          events_observed: hangOnMethod === "Debugger.enable" ? 1 : 0,
        },
      });
      expect(result.error.userMessage ?? "").not.toContain(
        "command_timeout_ms",
      );
      expect(result.error.userMessage ?? "").not.toContain(
        "--command-timeout-ms",
      );
    } finally {
      await inspector.close();
    }
  },
);

it("keeps the chosen observation window independent of command deadlines", async () => {
  const browser = await startFakeCdpBrowser();
  const observationMs = WEB_RUNTIME_LIMITS.commandTimeoutMs + 250;
  try {
    const pending = new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: observationMs,
      }),
    );
    await waitFor(() => expect(activeTimers(observationMs)).toHaveLength(1));
    expect(activeTimers(WEB_RUNTIME_LIMITS.commandTimeoutMs)).toHaveLength(0);
    expireTimer(observationMs);
    const result = await pending;
    expect(result.ok).toBe(true);
  } finally {
    await browser.close();
  }
});

it("starts the frame-tree command deadline only after HTTP discovery", async () => {
  const discovery = phaseGate<string>();
  const commandTimeoutMs = 25_000;
  const browser = await startFakeCdpBrowser({
    hangOnMethod: "Page.getFrameTree",
    discoveryGate: discovery,
  });
  const provider = new CdpWebRuntimeProvider();
  const controller = new AbortController();
  const pending = provider.observeExecution(
    observeWebExecutionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      observation_ms: 1,
      command_timeout_ms: commandTimeoutMs,
    }),
    { signal: controller.signal },
  );
  try {
    await discovery.reached(pending, "HTTP discovery");
    expect(activeTimers(commandTimeoutMs)).toHaveLength(0);
    discovery.release();
    await waitFor(() =>
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Page.getFrameTree",
      ),
    );
    expireEveryTimer(commandTimeoutMs);
    const result = await pending;
    if (result.ok) throw new Error("Expected a command deadline");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "provider_timeout",
      message: expect.stringContaining(
        `CDP command Page.getFrameTree exceeded its ${String(commandTimeoutMs)} ms command_timeout_ms`,
      ),
      details: {
        limit: {
          parameter: "command_timeout_ms",
          effective_value: commandTimeoutMs,
        },
      },
    });
    expect(browser.httpRequests.map(({ url }) => url)).toEqual(
      expect.arrayContaining(["/json/version", "/json/list"]),
    );
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  } finally {
    controller.abort();
    discovery.release();
    await pending.catch(() => undefined);
    await provider.close();
    await browser.close();
  }
});

it("gives browser-socket attach its own command deadline after the handshake", async () => {
  const commandTimeoutMs = 25_000;
  const handshake = phaseGate<string>();
  const controller = new AbortController();
  const browser = await startFakeCdpBrowser({
    handshakeGate: handshake,
    hangOnMethod: "Target.attachToTarget",
  });
  const provider = new CdpWebRuntimeProvider();
  const pending = provider.observeExecution(
    observeWebExecutionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      observation_ms: 1,
      command_timeout_ms: commandTimeoutMs,
    }),
    { signal: controller.signal },
  );
  try {
    expect(await handshake.reached(pending, "target WebSocket handshake")).toBe(
      "/devtools/browser/fake",
    );
    const handshakeTimers = activeTimers(commandTimeoutMs);
    expect(handshakeTimers).toHaveLength(1);
    expect(browser.commands).toHaveLength(0);
    handshake.release();
    await waitFor(() =>
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Target.attachToTarget",
      ),
    );
    const attachTimers = activeTimers(commandTimeoutMs);
    expect(attachTimers).toHaveLength(1);
    expect(attachTimers[0]?.timer).not.toBe(handshakeTimers[0]?.timer);
    expireTimer(commandTimeoutMs);
    const result = await pending;
    if (result.ok) throw new Error("Expected an attach deadline");
    const text = `${result.error.userMessage ?? ""}\n${result.error.message}`;
    expect(text).toContain(
      `CDP command Target.attachToTarget exceeded its ${String(commandTimeoutMs)} ms command_timeout_ms`,
    );
    expect(text).not.toContain("WebSocket handshake exceeded");
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  } finally {
    controller.abort();
    handshake.release();
    await pending.catch(() => undefined);
    await provider.close();
    await browser.close();
  }
});

it("stops a stalled blocked-service-worker check before discovery", async () => {
  const commandTimeoutMs = 25_000;
  const browser = await startFakeCdpBrowser();
  const frame = {
    evaluate: () => new Promise<null>(() => undefined),
    isDetached: () => false,
    url: () => `${browser.allowedOrigin}/app`,
  };
  const workers = new PlaywrightScenarioServiceWorkers(
    {
      frames: () => [frame],
      isClosed: () => false,
      mainFrame: () => frame,
    } as unknown as ConstructorParameters<
      typeof PlaywrightScenarioServiceWorkers
    >[0],
    browser.endpoint,
    "allowed-page",
    commandTimeoutMs,
  );
  // Keep the monotonic deadline and its explicitly expired timer in sync.
  const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
  const pending = workers.initialize();
  try {
    await waitFor(() =>
      expect(activeTimers(SERVICE_WORKER_POLICY_CHECK_TIMEOUT_MS)).toHaveLength(
        1,
      ),
    );
    expect(browser.httpRequests).toHaveLength(0);
    expect(browser.commands).toHaveLength(0);
    expect(activeTimers(commandTimeoutMs)).toHaveLength(0);
    clock.mockReturnValue(1_000 + SERVICE_WORKER_POLICY_CHECK_TIMEOUT_MS);
    expireTimer(SERVICE_WORKER_POLICY_CHECK_TIMEOUT_MS);
    const failure = await pending.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisTimeoutError);
    if (!(failure instanceof AnalysisTimeoutError))
      throw new Error("Expected a policy-check deadline");
    const text = `${failure.userMessage ?? ""}\n${failure.message}`;
    expect(text).toContain(
      `${String(SERVICE_WORKER_POLICY_CHECK_TIMEOUT_MS)} ms deadline before CDP discovery`,
    );
    expect(text).toContain("command_timeout_ms does not apply");
    expect(browser.httpRequests).toHaveLength(0);
    expect(activeTimers(commandTimeoutMs)).toHaveLength(0);
  } finally {
    clock.mockRestore();
    const closing = workers.close().catch(() => undefined);
    await browser.close();
    await closing;
    await pending.catch(() => undefined);
  }
});

it("keeps blocked service-worker attachment outside the discovery deadline", async () => {
  const commandTimeoutMs = 25_000;
  const browser = await startFakeCdpBrowser({
    hangOnMethod: "Target.attachToTarget",
  });
  const frame = {
    evaluate: async () => null,
    isDetached: () => false,
    url: () => `${browser.allowedOrigin}/app`,
  };
  const workers = new PlaywrightScenarioServiceWorkers(
    {
      frames: () => [frame],
      isClosed: () => false,
      mainFrame: () => frame,
    } as unknown as ConstructorParameters<
      typeof PlaywrightScenarioServiceWorkers
    >[0],
    browser.endpoint,
    "allowed-page",
    commandTimeoutMs,
  );
  const pending = workers.initialize();
  try {
    await waitFor(() =>
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Target.attachToTarget",
      ),
    );
    expect(activeTimers(CDP_DISCOVERY_RESPONSE_TIMEOUT_MS)).toHaveLength(0);
    expect(activeTimers(commandTimeoutMs)).toHaveLength(1);
  } finally {
    const closing = workers.close().catch(() => undefined);
    await browser.close();
    await closing;
    await pending.catch(() => undefined);
  }
});

it("reports a stalled browser-socket handshake on the discovery deadline", async () => {
  const discoveryTimeoutMs = 20_000;
  const commandTimeoutMs = 25_000;
  const server = await startStalledHandshake();
  const controller = new AbortController();
  const pending = openCdpEndpoint(
    browserObservationEndpointSchema.parse(
      server.url("/devtools/browser/stalled"),
    ),
    "list_browser_targets",
    controller.signal,
    discoveryTimeoutMs,
    undefined,
    commandTimeoutMs,
  ).catch((cause: unknown) => cause);
  try {
    await waitFor(() => expect(server.sockets.size).toBe(1));
    expect(activeTimers(commandTimeoutMs)).toHaveLength(0);
    expireTimer(discoveryTimeoutMs);
    const failure = await pending;
    expect(failure).toBeInstanceOf(BrowserObservationError);
    if (!(failure instanceof BrowserObservationError))
      throw new Error("Expected a browser-socket discovery failure");
    const text = `${failure.userMessage ?? ""}\n${failure.message}`;
    expect(text).toContain(
      `CDP browser-socket discovery exceeded its ${String(discoveryTimeoutMs)} ms discovery_timeout_ms deadline`,
    );
    expect(text).toContain(
      `${String(WEB_RUNTIME_LIMITS.protocolBytes)}-byte browser-socket message budget`,
    );
    expect(text).not.toContain("8388608-byte discovery document budget");
    await waitFor(() => expect(server.sockets.size).toBe(0));
  } finally {
    controller.abort();
    await pending;
    await server.close();
  }
});

it("reschedules a raised command deadline onto the fixed cleanup grace", async () => {
  const browser = await startFakeCdpBrowser({ hangOnMethod: "Runtime.enable" });
  const connection = await CdpConnection.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    undefined,
    { commandTimeoutMs: 60_000 },
  );
  try {
    const pending = connection.send("Runtime.enable");
    await waitFor(() => expect(browser.commands).toHaveLength(1));
    expect(activeTimers(60_000)).toHaveLength(1);
    connection.beginCleanupGrace(5_000);
    expect(activeTimers(60_000)).toHaveLength(0);
    expireTimer(5_000);
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ reason: "timeout" });
    if (!(error instanceof BrowserObservationError))
      throw new Error("Expected cleanup grace timeout");
    expect(error.userMessage).toContain("5000 ms");
    expect(error.userMessage).not.toContain("Increase command_timeout_ms");
    expect(error.remediationAction).toContain("no runtime override");
  } finally {
    await connection.close();
    await browser.close();
  }
});

it("keeps runtime cleanup on the fixed grace when command_timeout_ms is shorter", async () => {
  const commandTimeoutMs = 250;
  const browser = await startRuntimeBrowser({
    hangOnMethod: "Profiler.disable",
  });
  const provider = new CdpWebRuntimeProvider();
  try {
    const pending = provider.observeExecution(
      observeWebExecutionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 1,
        command_timeout_ms: commandTimeoutMs,
      }),
      { signal: AbortSignal.timeout(10_000) },
    );
    await waitFor(() =>
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Profiler.disable",
      ),
    );
    expect(activeTimers(commandTimeoutMs)).toHaveLength(0);
    expect(
      activeTimers(WEB_RUNTIME_LIMITS.cleanupTimeoutMs).length,
    ).toBeGreaterThan(0);
    const hung = browser.commands.find(
      ({ method }) => method === "Profiler.disable",
    );
    if (hung === undefined) throw new Error("Expected Profiler.disable");
    browser.emitRawMessage(
      JSON.stringify({
        id: hung.id,
        ...(hung.sessionId === undefined ? {} : { sessionId: hung.sessionId }),
        result: {},
      }),
    );
    const result = await pending;
    expect(result.ok).toBe(true);
  } finally {
    await provider.close();
    await browser.close();
  }
});

it("names the fixed cleanup grace when runtime restoration stalls", async () => {
  const commandTimeoutMs = 250;
  const browser = await startRuntimeBrowser({
    hangOnMethod: "Profiler.disable",
  });
  const provider = new CdpWebRuntimeProvider();
  try {
    const pending = provider.observeExecution(
      observeWebExecutionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 1,
        command_timeout_ms: commandTimeoutMs,
      }),
      { signal: AbortSignal.timeout(10_000) },
    );
    await waitFor(() =>
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Profiler.disable",
      ),
    );
    expect(activeTimers(commandTimeoutMs)).toHaveLength(0);
    expireEveryTimer(WEB_RUNTIME_LIMITS.cleanupTimeoutMs);
    const result = await pending;
    if (result.ok) throw new Error("Expected cleanup grace failure");
    const text = JSON.stringify(result.error.diagnostics);
    expect(text).toContain("5000 ms");
    expect(text).toContain("no runtime override");
    expect(text).not.toContain(
      `${String(commandTimeoutMs)} ms command_timeout_ms`,
    );
    expect(text).not.toContain("Increase command_timeout_ms");
  } finally {
    await provider.close();
    await browser.close();
  }
});

it("applies caller-selected discovery_timeout_ms to browser-socket discovery", async () => {
  const discoveryTimeoutMs = 45_000;
  const browser = await startFakeCdpBrowser({
    hangOnMethod: "Target.getTargets",
  });
  const provider = new CdpBrowserProvider();
  try {
    const pending = provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
        discovery_timeout_ms: discoveryTimeoutMs,
      }),
    );
    await waitFor(() =>
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Target.getTargets",
      ),
    );
    expect(activeTimers(CDP_DISCOVERY_RESPONSE_TIMEOUT_MS)).toHaveLength(0);
    expect(activeTimers(discoveryTimeoutMs)).not.toHaveLength(0);
    expireEveryTimer(discoveryTimeoutMs);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected browser-socket discovery timeout");
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("provider_timeout");
    expect(projected.message).toContain(
      `${String(discoveryTimeoutMs)} ms discovery_timeout_ms`,
    );
    expect(projected.remediation?.action).not.toContain("--");
    expect(projected.details?.limit).toMatchObject({
      control_kind: "parameter",
      parameter: "discovery_timeout_ms",
      effective_value: discoveryTimeoutMs,
      applies_at: "next_call",
    });
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  } finally {
    await provider.close();
    await browser.close();
  }
});

it("applies caller-selected discovery_timeout_ms to HTTP discovery independently of command_timeout_ms", async () => {
  const discoveryTimeoutMs = 35_000;
  const commandTimeoutMs = 25_000;
  const discovery = phaseGate<string>();
  const browser = await startFakeCdpBrowser({ discoveryGate: discovery });
  const provider = new CdpBrowserProvider();
  const controller = new AbortController();
  const pending = provider.inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      observation_ms: 0,
      discovery_timeout_ms: discoveryTimeoutMs,
      command_timeout_ms: commandTimeoutMs,
    }),
    { signal: controller.signal },
  );
  try {
    expect(await discovery.reached(pending, "HTTP version discovery")).toBe(
      "/json/version",
    );
    expect(activeTimers(CDP_DISCOVERY_RESPONSE_TIMEOUT_MS)).toHaveLength(0);
    expect(activeTimers(commandTimeoutMs)).toHaveLength(0);
    expireTimer(discoveryTimeoutMs);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected HTTP discovery timeout");
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("provider_timeout");
    expect(projected.message).toContain(
      `${String(discoveryTimeoutMs)} ms discovery_timeout_ms`,
    );
    expect(projected.remediation?.action).not.toContain("--");
    expect(projected.details?.limit).toMatchObject({
      control_kind: "parameter",
      parameter: "discovery_timeout_ms",
      effective_value: discoveryTimeoutMs,
    });
    expect(projected.remediation?.action).toContain(
      "command_timeout_ms does not raise it",
    );
  } finally {
    controller.abort();
    discovery.release();
    await pending.catch(() => undefined);
    await provider.close();
    await browser.close();
  }
});

it("clamps browser-socket handshake timers at MAX_NODE_TIMER_DELAY_MS without 32-bit timer overflow", async () => {
  const handshake = phaseGate<string>();
  const browser = await startFakeCdpBrowser({ handshakeGate: handshake });
  const provider = new CdpBrowserProvider();
  const controller = new AbortController();
  const pending = provider.listTargets(
    listBrowserTargetsInputSchema.parse({
      cdp_endpoint: browser.browserWebSocketUrl,
      discovery_timeout_ms: MAX_NODE_TIMER_DELAY_MS,
    }),
    { signal: controller.signal },
  );
  try {
    await handshake.reached(pending, "maximum-deadline browser handshake");
    const scheduledDelays = vi
      .mocked(globalThis.setTimeout)
      .mock.calls.flatMap(([, delay]) =>
        typeof delay === "number" ? [delay] : [],
      );
    expect(scheduledDelays).toContain(MAX_NODE_TIMER_DELAY_MS);
    expect(Math.max(...scheduledDelays)).toBeLessThanOrEqual(
      MAX_NODE_TIMER_DELAY_MS,
    );
    handshake.release();
    const listed = await pending;
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets.length).toBeGreaterThan(0);
  } finally {
    controller.abort();
    handshake.release();
    await pending.catch(() => undefined);
    await provider.close();
    await browser.close();
  }

  const server = await startStalledHandshake();
  try {
    const pending = openCdpEndpoint(
      browserObservationEndpointSchema.parse(
        server.url("/devtools/browser/max-deadline"),
      ),
      "list_browser_targets",
      undefined,
      MAX_NODE_TIMER_DELAY_MS,
    ).catch((cause: unknown) => cause);
    await waitFor(() => expect(server.sockets.size).toBe(1));
    expireEveryTimer(MAX_NODE_TIMER_DELAY_MS);
    const failure = await pending;
    expect(failure).toBeInstanceOf(BrowserObservationError);
    if (!(failure instanceof BrowserObservationError))
      throw new Error("Expected maximum discovery deadline failure");
    expect(failure.userMessage).toContain(
      `CDP browser-socket discovery exceeded its ${String(MAX_NODE_TIMER_DELAY_MS)} ms discovery_timeout_ms deadline`,
    );
    expect(failure.remediationAction).toContain(
      `discovery_timeout_ms is already at the maximum ${String(MAX_NODE_TIMER_DELAY_MS)} ms`,
    );
  } finally {
    await server.close();
  }
});
