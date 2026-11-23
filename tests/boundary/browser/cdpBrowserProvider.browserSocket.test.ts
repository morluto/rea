import { createServer, type Socket } from "node:net";

import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  controlledCleanup,
  phaseArrival,
  phaseGate,
  type PhaseGate,
} from "../../support/lifecycleHarness.js";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { CdpTargetSessionOwner } from "../../../src/browser/CdpTargetSessionOwner.js";
import { openCdpEndpoint } from "../../../src/browser/CdpTargetSession.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import {
  browserObservationEndpointSchema,
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../../../src/domain/browserObservation.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";
import { waitFor } from "../../support/testWait.js";

describe("CdpBrowserProvider: browser socket without HTTP discovery", () => {
  it("reuses one admitted browser socket across sequential operations and closes on provider shutdown", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    try {
      const throughHttp = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({ cdp_endpoint: browser.endpoint }),
      );
      if (!throughHttp.ok) throw throughHttp.error;
      const httpRequests = browser.httpRequests.length;
      const openedBefore = browser.openedConnectionCount();

      const listed = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
        }),
      );
      if (!listed.ok) throw listed.error;
      expect(listed.value.targets).toEqual(throughHttp.value.targets);
      expect(listed.value.excluded).toEqual(throughHttp.value.excluded);
      expect(listed.value.browser).toEqual({
        ...throughHttp.value.browser,
        revision: "@fake-revision",
      });
      expect(browser.openedConnectionCount()).toBe(openedBefore + 1);
      expect(browser.activeConnectionCount()).toBe(1);

      const commandsBeforeInspect = browser.commands.length;
      const inspected = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!inspected.ok) throw inspected.error;
      expect(inspected.value.target.origin).toBe(browser.allowedOrigin);
      expect(
        browser.commands
          .slice(commandsBeforeInspect, commandsBeforeInspect + 3)
          .map(({ method, params }) => ({ method, params })),
      ).toEqual([
        { method: "Browser.getVersion", params: {} },
        { method: "Target.getTargets", params: {} },
        {
          method: "Target.attachToTarget",
          params: { targetId: "allowed-page", flatten: true },
        },
      ]);
      expect(
        browser.commands
          .slice(commandsBeforeInspect)
          .map(({ method }) => method),
      ).toContain("Target.detachFromTarget");
      expect(browser.openedConnectionCount()).toBe(openedBefore + 1);
      expect(browser.activeConnectionCount()).toBe(1);

      const commandsBeforeScreenshot = browser.commands.length;
      const screenshot = await provider.captureScreenshot(
        captureWebScreenshotInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
        }),
      );
      if (!screenshot.ok) throw screenshot.error;
      expect(
        browser.commands
          .slice(commandsBeforeScreenshot)
          .map(({ method }) => method),
      ).toContain("Target.detachFromTarget");
      expect(browser.httpRequests).toHaveLength(httpRequests);
      expect(browser.openedConnectionCount()).toBe(openedBefore + 1);
      expect(browser.activeConnectionCount()).toBe(1);
    } finally {
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });
});

describe("CdpBrowserProvider: browser socket eviction and per-call scoping", () => {
  it("evicts a dropped browser socket and reconnects cleanly on the next call", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    try {
      const first = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
        }),
      );
      if (!first.ok) throw first.error;
      expect(browser.openedConnectionCount()).toBe(1);
      expect(browser.activeConnectionCount()).toBe(1);

      browser.closeActiveConnections();
      await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));

      const second = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!second.ok) throw second.error;
      expect(second.value.target.origin).toBe(browser.allowedOrigin);
      expect(browser.openedConnectionCount()).toBe(2);
      expect(browser.activeConnectionCount()).toBe(1);
    } finally {
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });

  it("closes a shared browser socket when Target.detachFromTarget fails so no target session leaks", async () => {
    const browser = await startFakeCdpBrowser({
      commandError: ({ method }) =>
        method === "Target.detachFromTarget"
          ? { code: -32_000, message: "Detach rejected" }
          : undefined,
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    try {
      const inspected = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!inspected.ok) throw inspected.error;
      await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
      expect(browser.openedConnectionCount()).toBe(1);

      const listed = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
        }),
      );
      if (!listed.ok) throw listed.error;
      expect(browser.openedConnectionCount()).toBe(2);
      expect(browser.activeConnectionCount()).toBe(1);
    } finally {
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });

  it("preserves per-operation command_timeout_ms and operation identity on a reused browser socket", async () => {
    const sent = phaseArrival();
    const browser = await startFakeCdpBrowser({
      commandDelayMs: ({ method }) => {
        if (method !== "Page.enable") return undefined;
        sent.arrive();
        return 200;
      },
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const controller = new AbortController();
    const endpoint = { cdp_endpoint: browser.browserWebSocketUrl };
    let inspecting: ReturnType<CdpBrowserProvider["inspectPage"]> | undefined;
    try {
      const listed = await provider.listTargets(
        listBrowserTargetsInputSchema.parse(endpoint),
      );
      if (!listed.ok) throw listed.error;
      expect(browser.openedConnectionCount()).toBe(1);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      inspecting = provider.inspectPage(
        inspectWebPageInputSchema.parse({
          ...endpoint,
          target_id: "allowed-page",
          observation_ms: 0,
          command_timeout_ms: 60,
        }),
        { signal: controller.signal },
      );
      await sent.reached(inspecting, "Page.enable on reused socket");
      await vi.advanceTimersByTimeAsync(60);
      expect(await inspecting).toMatchObject({
        ok: false,
        error: {
          _tag: "BrowserObservationError",
          operation: "inspect_web_page",
          reason: "timeout",
          userMessage: expect.stringContaining("60 ms command_timeout_ms"),
        },
      });
      expect(browser.openedConnectionCount()).toBe(1);
    } finally {
      controller.abort();
      vi.useRealTimers();
      await Promise.allSettled([inspecting]);
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });
});

it("retains browser-socket siblings and identifies malformed rows by their discovery position", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Target.getTargets"
        ? {
            targetInfos: [
              {
                targetId: "first",
                type: "page",
                title: 3,
                url: "https://example.test/first",
                attached: "unknown",
              },
              {
                targetId: "second",
                type: "page",
                title: "Good",
                url: "https://example.test/second",
                attached: false,
              },
              {
                targetId: "missing-url",
                type: "page",
              },
              { id: "alias", type: "page", url: "https://example.test/alias" },
            ],
          }
        : undefined,
  });
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  try {
    const result = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
      }),
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.targets.map(({ target_id, attached, title }) => [
        target_id,
        attached,
        title,
      ]),
    ).toEqual([
      ["first", null, ""],
      ["second", false, "Good"],
    ]);
    expect(result.value.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'CDP Target.getTargets row 0 target first reported malformed attached metadata "unknown"',
        ),
        expect.stringContaining(
          "CDP Target.getTargets row 0 target first reported malformed title metadata 3",
        ),
        expect.stringContaining(
          "CDP Target.getTargets row 2 was excluded because its target identity is malformed",
        ),
        expect.stringContaining(
          "CDP Target.getTargets row 3 was excluded because its target identity is malformed",
        ),
      ]),
    );
  } finally {
    await provider.close();
  }
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

describe("CdpBrowserProvider: browser socket failures and cleanup", () => {
  it("retains an admitted browser socket when the target is missing and closes it on shutdown", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    try {
      const result = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "missing",
          observation_ms: 0,
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "BrowserObservationError", reason: "target_not_found" },
      });
      expect(browser.commands.map(({ method }) => method)).toEqual([
        "Browser.getVersion",
        "Target.getTargets",
      ]);
      expect(browser.openedConnectionCount()).toBe(1);
      expect(browser.activeConnectionCount()).toBe(1);

      const recovered = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!recovered.ok) throw recovered.error;
      expect(browser.openedConnectionCount()).toBe(1);
    } finally {
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });

  it("rejects malformed discovery replies and admits an explicitly empty inventory", async () => {
    let malformed:
      | { method: string; reply: Record<string, unknown> }
      | undefined;
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) => {
        if (method === malformed?.method) return malformed.reply;
        return method === "Target.getTargets" ? { targetInfos: [] } : undefined;
      },
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const input = listBrowserTargetsInputSchema.parse({
      cdp_endpoint: browser.browserWebSocketUrl,
    });
    try {
      for (const invalidReply of [
        {
          method: "Browser.getVersion",
          reply: { product: "FakeChrome/1.0", protocolVersion: "" },
        },
        { method: "Target.getTargets", reply: { targetInfos: null } },
      ]) {
        malformed = invalidReply;
        expect(await provider.listTargets(input)).toMatchObject({
          ok: false,
          error: {
            _tag: "BrowserObservationError",
            operation: "list_browser_targets",
            reason: "invalid_endpoint_response",
            detail: expect.stringContaining(`CDP ${invalidReply.method}`),
          },
        });
        await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
      }

      malformed = undefined;
      expect(await provider.listTargets(input)).toMatchObject({
        ok: true,
        value: {
          targets: [],
          excluded: { disallowed_origin: 0, non_page: 0, unsupported_url: 0 },
        },
      });
    } finally {
      await provider.close();
    }
  });

  it("reports a refused browser socket as unreachable", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl.replace(
          /fake$/u,
          "not-this-browser",
        ),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        reason: "endpoint_unreachable",
      },
    });
    expect(JSON.stringify(result)).not.toContain("not-this-browser");
  });

  it("cancels browser-socket discovery and releases the socket", async () => {
    const browser = await startFakeCdpBrowser({
      hangOnMethod: "Target.getTargets",
    });
    trackBrowser(browser);
    const controller = new AbortController();
    const pending = new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
        target_id: "allowed-page",
        observation_ms: 0,
      }),
      { signal: controller.signal },
    );
    await waitFor(() =>
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Target.getTargets",
      ),
    );
    controller.abort();

    expect(await pending).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "inspect_web_page" },
    });
    expect(browser.commands.map(({ method }) => method)).not.toContain(
      "Target.attachToTarget",
    );
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });
});

const expectDiscoveryTimeout = async (
  url: string,
  reached: ReturnType<typeof phaseArrival>,
): Promise<void> => {
  const controller = new AbortController();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const opening = openCdpEndpoint(
    browserObservationEndpointSchema.parse(url),
    "list_browser_targets",
    controller.signal,
    50,
  );
  try {
    await reached.reached(opening, "discovery producer request");
    await vi.advanceTimersByTimeAsync(50);
    const failure: unknown = await opening.catch((cause: unknown) => cause);
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected a typed discovery failure", { cause: failure });
    expect(failure).toMatchObject({
      _tag: "BrowserObservationError",
      operation: "list_browser_targets",
      reason: "timeout",
    });
    expect(projectAnalysisError(failure)).toMatchObject({
      code: "provider_timeout",
      category: "timeout",
    });
  } finally {
    controller.abort();
    vi.useRealTimers();
    await Promise.allSettled([opening]);
  }
};

describe("CdpBrowserProvider: browser socket discovery deadline", () => {
  it("times out a discovery reply that never arrives and closes the socket", async () => {
    const sent = phaseArrival();
    const browser = await startFakeCdpBrowser({
      commandDelayMs: ({ method }) => {
        if (method !== "Target.getTargets") return undefined;
        sent.arrive();
        return 200;
      },
    });
    trackBrowser(browser);
    await expectDiscoveryTimeout(browser.browserWebSocketUrl, sent);
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });

  it("times out a WebSocket handshake that never completes", async () => {
    const sockets = new Set<Socket>();
    const sent = phaseArrival();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.once("data", () => sent.arrive());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected a TCP listener address");
    onTestFinished(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await expectDiscoveryTimeout(
      `ws://127.0.0.1:${String(address.port)}/devtools/browser/stalled`,
      sent,
    );
    await waitFor(() => expect(sockets.size).toBe(0));
  });
});

const startPeerObservation = (
  provider: CdpBrowserProvider,
  cdpEndpoint: string,
) => {
  const started = phaseArrival();
  const controller = new AbortController();
  const endpoint = { cdp_endpoint: cdpEndpoint };
  const target = { ...endpoint, target_id: "allowed-page" };
  const observing = provider.observeSession(
    observeWebSessionInputSchema.parse({ ...target, observation_ms: 15_000 }),
    {
      signal: controller.signal,
      progress: {
        report: async (update) => {
          if (update.completed === 1) started.arrive();
        },
      },
    },
  );
  return { controller, endpoint, observing, started, target };
};

const observePeerDuringDetachFailure = async (refuseClose = false) => {
  const browser = await startFakeCdpBrowser({
    commandError: ({ method }) =>
      method === "Target.detachFromTarget"
        ? { code: -32_000, message: "Detach rejected" }
        : undefined,
  });
  const provider = new CdpBrowserProvider();
  const cleanup = controlledCleanup({ refused: refuseClose });
  const originalClose = CdpConnection.prototype.close;
  const closeSpy = vi
    .spyOn(CdpConnection.prototype, "close")
    .mockImplementation(function (this: CdpConnection) {
      return cleanup.close(() => originalClose.call(this));
    });
  const { controller, endpoint, observing, started, target } =
    startPeerObservation(provider, browser.browserWebSocketUrl);
  onTestFinished(async () => {
    cleanup.allow();
    controller.abort();
    try {
      await Promise.allSettled([observing]);
      await provider.close();
      await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    } finally {
      closeSpy.mockRestore();
      await browser.close();
    }
  });
  await started.reached(observing, "peer session observation start");
  expect(browser.openedConnectionCount()).toBe(1);
  expect(browser.activeConnectionCount()).toBe(1);

  const inspect = () =>
    provider.inspectPage(
      inspectWebPageInputSchema.parse({ ...target, observation_ms: 0 }),
    );
  return {
    browser,
    cleanup,
    controller,
    endpoint,
    inspect,
    observing,
    provider,
  };
};

describe("CdpBrowserProvider: shared browser socket lifecycle regressions", () => {
  it.each(["rejected", "cancelled", "timed out", "malformed"] as const)(
    "retains a peer only when a failed page attachment is confirmed: %s",
    async (outcome) => {
      const controller = new AbortController();
      let failAttach = false;
      const browser = await startFakeCdpBrowser({
        commandError: ({ method }) => {
          if (!failAttach || method !== "Target.attachToTarget")
            return undefined;
          if (outcome === "cancelled") controller.abort();
          return outcome === "rejected"
            ? { code: -32602, message: "No target with given id found" }
            : undefined;
        },
        commandDelayMs: ({ method }) =>
          failAttach &&
          method === "Target.attachToTarget" &&
          outcome === "timed out"
            ? 2000
            : undefined,
        commandResult: ({ method }) =>
          failAttach &&
          method === "Target.attachToTarget" &&
          outcome === "malformed"
            ? {}
            : undefined,
      });
      trackBrowser(browser);
      const provider = new CdpBrowserProvider();
      const {
        controller: peerController,
        target,
        started,
        observing,
      } = startPeerObservation(provider, browser.browserWebSocketUrl);
      try {
        await started.reached(observing, "peer session observation start");
        const sessionId = browser.commands.find(
          ({ method }) => method === "Performance.getMetrics",
        )?.sessionId;
        expect(sessionId).toBeDefined();
        const inspect = inspectWebPageInputSchema.parse({
          ...target,
          observation_ms: 0,
          ...(outcome === "timed out" ? { command_timeout_ms: 200 } : {}),
        });
        failAttach = true;
        const failed = await provider.inspectPage(inspect, {
          signal: controller.signal,
        });
        failAttach = false;
        expect(failed).toMatchObject({
          ok: false,
          error:
            outcome === "cancelled"
              ? { _tag: "AnalysisCancelledError" }
              : {
                  reason:
                    outcome === "timed out" ? "timeout" : "protocol_error",
                },
        });
        browser.emitEvent({
          method: "Inspector.targetCrashed",
          sessionId,
          params: {},
        });
        const peer = await observing;
        if (!peer.ok) throw peer.error;
        expect(peer.value.window.end_reason).toBe(
          outcome === "rejected"
            ? "target_terminated"
            : "transport_disconnected",
        );
        const next = await provider.inspectPage(inspect);
        if (!next.ok) throw next.error;
        expect(browser.openedConnectionCount()).toBe(
          outcome === "rejected" ? 1 : 2,
        );
      } finally {
        peerController.abort();
        await observing;
        await provider.close();
      }
      await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    },
  );

  it("closes a shared browser socket immediately when detach fails alongside an active observation", async () => {
    const { browser, cleanup, inspect, observing } =
      await observePeerDuringDetachFailure();
    const inspected = await inspect();
    if (!inspected.ok) throw inspected.error;
    expect(cleanup.attempts).toBe(1);
    expect(browser.openedConnectionCount()).toBe(1);
    const session = await observing;
    if (!session.ok) throw session.error;
    expect(session.value.window.end_reason).toBe("transport_disconnected");
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });

  it("surfaces cleanupIncomplete when forced shared-socket close fails after detach rejection", async () => {
    const { browser, cleanup, controller, inspect, observing, provider } =
      await observePeerDuringDetachFailure(true);
    const inspected = await inspect();
    if (inspected.ok) throw new Error("Expected incomplete transport cleanup");
    expect(inspected.error.cleanupIncomplete).toBe(true);
    const observation = inspected.error.partialObservation;
    expect(observation).toMatchObject({
      target: { target_id: "allowed-page" },
    });

    const reason = new Error("end peer observation");
    controller.abort(reason);
    const ended = await observing;
    if (ended.ok) throw new Error("Expected peer cancellation");
    expect(ended.error.cleanupPrimary?.cause).toBe(reason);
    expect(ended.error.cleanupIncomplete).toBe(true);
    expect(browser.activeConnectionCount()).toBe(1);

    cleanup.allow();
    await provider.close();
    expect(inspected.error.cleanupIncomplete).toBe(false);
    expect(ended.error.cleanupIncomplete).toBe(false);
    expect(inspected.error.partialObservation).toBe(observation);
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });
});

describe("CdpTargetSessionOwner: callback failures and idle protocol eviction", () => {
  it("records cleanup lease ownership when finish() callback rejects and resolves on retryPending", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const owner = new CdpTargetSessionOwner();
    try {
      const connection = await owner.connect(
        browser.browserWebSocketUrl,
        "inspect_web_page",
        {},
        "callback-failed-session",
      );
      const cleanup = vi.fn(async () => {
        throw new Error("controlled cleanup callback failure");
      });
      const failure = await owner
        .finish(connection, cleanup)
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ProviderCleanupError);
      if (!(failure instanceof AnalysisError))
        throw new Error("Expected typed cleanup error");
      expect(failure.cleanupIncomplete).toBe(true);
      expect(failure.cleanupResources).toEqual(["callback-failed-session"]);
      expect(browser.activeConnectionCount()).toBe(1);

      await owner.retryPending();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(failure.cleanupIncomplete).toBe(false);
      await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    } finally {
      await owner.close();
    }
  });

  it("evicts and closes an idle retained browser socket on fatal protocol failure", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const originalClose = CdpConnection.prototype.close;
    let denyClose = true;
    const closeSpy = vi
      .spyOn(CdpConnection.prototype, "close")
      .mockImplementation(function (this: CdpConnection) {
        return denyClose
          ? Promise.reject(new Error("controlled idle protocol close failure"))
          : originalClose.call(this);
      });
    try {
      const first = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
        }),
      );
      if (!first.ok) throw first.error;
      expect(browser.activeConnectionCount()).toBe(1);

      browser.emitRawMessage("{not-json");
      await waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1));

      const blocked = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
        }),
      );
      if (blocked.ok) throw new Error("Expected pending cleanup refusal");
      expect(blocked.error.cleanupIncomplete).toBe(true);

      denyClose = false;
      const recovered = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
        }),
      );
      if (!recovered.ok) throw recovered.error;
      expect(blocked.error.cleanupIncomplete).toBe(false);
      expect(browser.openedConnectionCount()).toBe(2);
      expect(browser.activeConnectionCount()).toBe(1);

      browser.emitRawMessage("{not-json-idle-second");
      await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    } finally {
      closeSpy.mockRestore();
      await provider.close();
    }
  });
});

it("blocks new admissions while forced shared-socket cleanup fails with an active peer, then recovers cleanly", async () => {
  const { browser, cleanup, endpoint, inspect, observing, provider } =
    await observePeerDuringDetachFailure(true);
  const failedInspect = await inspect();
  if (failedInspect.ok)
    throw new Error("Expected failed forced shared-socket close");
  expect(failedInspect.error.cleanupIncomplete).toBe(true);

  const input = listBrowserTargetsInputSchema.parse(endpoint);
  const blocked = await provider.listTargets(input);
  if (blocked.ok)
    throw new Error("Expected admission blocked on failed cleanup");
  expect(blocked.error.cleanupIncomplete).toBe(true);
  expect(browser.openedConnectionCount()).toBe(1);

  cleanup.allow();
  const recovered = await provider.listTargets(input);
  if (!recovered.ok) throw recovered.error;
  expect(failedInspect.error.cleanupIncomplete).toBe(false);
  expect(blocked.error.cleanupIncomplete).toBe(false);
  expect(browser.openedConnectionCount()).toBe(2);

  const session = await observing;
  if (!session.ok) throw session.error;
  expect(session.value.window.end_reason).toBe("transport_disconnected");
});

it("keeps an admitted shared browser socket alive for concurrent peers when a caller aborts or hits discovery_timeout_ms", async () => {
  const timedDiscovery = phaseArrival();
  const cancelledDiscovery = phaseArrival();
  const stallDiscoveries: (typeof timedDiscovery)[] = [];
  const browser = await startFakeCdpBrowser({
    commandDelayMs: ({ method }) => {
      if (method !== "Target.getTargets") return undefined;
      const arrival = stallDiscoveries.shift();
      if (arrival === undefined) return undefined;
      arrival.arrive();
      return 200;
    },
  });
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const endpoint = { cdp_endpoint: browser.browserWebSocketUrl };
  const target = { ...endpoint, target_id: "allowed-page" };
  const observationStart = phaseArrival();
  const peerController = new AbortController();
  const timeoutController = new AbortController();
  const cancelController = new AbortController();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const observing = provider.observeSession(
    observeWebSessionInputSchema.parse({ ...target, observation_ms: 400 }),
    {
      signal: peerController.signal,
      progress: {
        report: async (update) => {
          if (update.completed === 1) observationStart.arrive();
        },
      },
    },
  );
  let timingOut: ReturnType<CdpBrowserProvider["inspectPage"]> | undefined;
  let cancelling: ReturnType<CdpBrowserProvider["listTargets"]> | undefined;
  try {
    await observationStart.reached(observing, "peer session observation start");
    stallDiscoveries.push(timedDiscovery, cancelledDiscovery);

    timingOut = provider.inspectPage(
      inspectWebPageInputSchema.parse({
        ...target,
        observation_ms: 0,
        discovery_timeout_ms: 35,
      }),
      { signal: timeoutController.signal },
    );
    await timedDiscovery.reached(timingOut, "discovery subject to deadline");
    await vi.advanceTimersByTimeAsync(35);
    expect(await timingOut).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "inspect_web_page",
        reason: "timeout",
        userMessage: expect.stringContaining("35 ms discovery_timeout_ms"),
      },
    });
    expect(browser.openedConnectionCount()).toBe(1);
    expect(browser.activeConnectionCount()).toBe(1);

    cancelling = provider.listTargets(
      listBrowserTargetsInputSchema.parse(endpoint),
      { signal: cancelController.signal },
    );
    await cancelledDiscovery.reached(
      cancelling,
      "discovery subject to cancellation",
    );
    const reason = new Error("caller cancelled discovery");
    cancelController.abort(reason);
    const cancelled = await cancelling;
    if (cancelled.ok) throw new Error("Expected discovery cancellation");
    expect(cancelled.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      operation: "list_browser_targets",
    });
    expect(cancelled.error.cause).toBe(reason);

    await vi.advanceTimersByTimeAsync(400);
    const session = await observing;
    if (!session.ok) throw session.error;
    expect(session.value.window.end_reason).toBe("window_elapsed");
    expect(browser.openedConnectionCount()).toBe(1);
    expect(browser.activeConnectionCount()).toBe(1);
  } finally {
    peerController.abort();
    timeoutController.abort();
    cancelController.abort();
    vi.useRealTimers();
    await Promise.allSettled([observing, timingOut, cancelling]);
    await provider.close();
  }
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

describe("CdpBrowserProvider: coalesced cold-start browser sockets", () => {
  it("coalesces concurrent cold-start calls onto one browser WebSocket handshake", async () => {
    const handshake = phaseGate<string>();
    const browser = await startFakeCdpBrowser({ handshakeGate: handshake });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    let batch:
      | Promise<
          [
            Awaited<ReturnType<CdpBrowserProvider["listTargets"]>>,
            Awaited<ReturnType<CdpBrowserProvider["inspectPage"]>>,
            Awaited<ReturnType<CdpBrowserProvider["captureScreenshot"]>>,
          ]
        >
      | undefined;
    try {
      batch = Promise.all([
        provider.listTargets(
          listBrowserTargetsInputSchema.parse({
            cdp_endpoint: browser.browserWebSocketUrl,
          }),
        ),
        provider.inspectPage(
          inspectWebPageInputSchema.parse({
            cdp_endpoint: browser.browserWebSocketUrl,
            target_id: "allowed-page",
            observation_ms: 0,
          }),
        ),
        provider.captureScreenshot(
          captureWebScreenshotInputSchema.parse({
            cdp_endpoint: browser.browserWebSocketUrl,
            target_id: "allowed-page",
          }),
        ),
      ]);
      await handshake.reached(batch, "coalesced browser handshake");
      handshake.release();
      const [listed, inspected, screenshot] = await batch;
      if (!listed.ok) throw listed.error;
      if (!inspected.ok) throw inspected.error;
      if (!screenshot.ok) throw screenshot.error;
      expect(listed.value.targets.length).toBeGreaterThan(0);
      expect(inspected.value.target.origin).toBe(browser.allowedOrigin);
      expect(screenshot.value.artifact.media_type).toBe("image/png");
      expect(browser.openedConnectionCount()).toBe(1);
      expect(browser.activeConnectionCount()).toBe(1);
      const targetSessionIds = new Set(
        browser.commands.flatMap((command) =>
          command.sessionId === undefined ? [] : [command.sessionId],
        ),
      );
      expect(targetSessionIds).toEqual(new Set(["session-1", "session-2"]));
      const detachedSessionIds = browser.commands
        .filter((command) => command.method === "Target.detachFromTarget")
        .map((command) => command.params.sessionId)
        .sort();
      expect(detachedSessionIds).toEqual(["session-1", "session-2"]);
    } finally {
      handshake.release();
      await batch?.catch(() => undefined);
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });

  it("keeps an in-flight cold-start handshake alive for a longer-deadline peer when one waiter times out", async () => {
    const handshake = phaseGate<string>();
    const browser = await startFakeCdpBrowser({ handshakeGate: handshake });
    const shortDeadlineMs = 25_000;
    const longDeadlineMs = 45_000;
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    let shortCall: ReturnType<CdpBrowserProvider["listTargets"]> | undefined;
    let longCall: ReturnType<CdpBrowserProvider["inspectPage"]> | undefined;
    try {
      shortCall = provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          discovery_timeout_ms: shortDeadlineMs,
        }),
      );
      longCall = provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
          discovery_timeout_ms: longDeadlineMs,
        }),
      );

      await handshake.reached(shortCall, "cold-start browser handshake");
      const shortTimers = scheduled.mock.calls.filter(
        ([, delay]) => delay === shortDeadlineMs,
      );
      expect(shortTimers).toHaveLength(1);
      shortTimers[0]?.[0]();
      const shortOutcome = await shortCall;
      expect(shortOutcome).toMatchObject({
        ok: false,
        error: {
          _tag: "BrowserObservationError",
          operation: "list_browser_targets",
          reason: "timeout",
        },
      });
      if (shortOutcome.ok)
        throw new Error("Expected short cold-start waiter to time out");
      expect(shortOutcome.error.userMessage).toContain(
        `${shortDeadlineMs} ms discovery_timeout_ms`,
      );

      expect(browser.openedConnectionCount()).toBe(0);
      handshake.release();
      const longOutcome = await longCall;
      if (!longOutcome.ok) throw longOutcome.error;
      expect(longOutcome.value.target.origin).toBe(browser.allowedOrigin);
      expect(browser.openedConnectionCount()).toBe(1);
      expect(browser.activeConnectionCount()).toBe(1);

      const followUp = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
        }),
      );
      if (!followUp.ok) throw followUp.error;
      expect(browser.openedConnectionCount()).toBe(1);
    } finally {
      handshake.release();
      await Promise.allSettled([shortCall, longCall]);
      scheduled.mockRestore();
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });
});

const holdProgressStep = (step: number, gate: PhaseGate) => ({
  async report(update: { readonly completed: number }) {
    if (update.completed === step) await gate.hold();
  },
});

it("isolates concurrent target sessions on one shared browser socket when a shorter call detaches first", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const controller = new AbortController();
  // Both peers stay held until the shorter screenshot call has detached.
  const observationHeld = phaseGate();
  const inspectionHeld = phaseGate();
  const releasePeers = () => {
    observationHeld.release();
    inspectionHeld.release();
  };
  let observing: ReturnType<CdpBrowserProvider["observeSession"]> | undefined;
  let inspecting: ReturnType<CdpBrowserProvider["inspectPage"]> | undefined;
  let capturing:
    | ReturnType<CdpBrowserProvider["captureScreenshot"]>
    | undefined;
  try {
    observing = provider.observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
        target_id: "allowed-page",
        observation_ms: 1,
      }),
      {
        signal: controller.signal,
        progress: holdProgressStep(1, observationHeld),
      },
    );
    await observationHeld.reached(
      observing,
      "shared browser-socket observation start",
    );

    inspecting = provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
        target_id: "allowed-page",
        observation_ms: 0,
      }),
      {
        signal: controller.signal,
        progress: holdProgressStep(2, inspectionHeld),
      },
    );
    await inspectionHeld.reached(
      inspecting,
      "shared browser-socket inspection hold",
    );

    capturing = provider.captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
        target_id: "allowed-page",
      }),
      { signal: controller.signal },
    );
    const screenshot = await capturing;
    if (!screenshot.ok) throw screenshot.error;
    expect(screenshot.value.artifact.media_type).toBe("image/png");
    const detachesAfterScreenshot = browser.commands
      .filter((command) => command.method === "Target.detachFromTarget")
      .map((command) => command.params.sessionId);
    expect(detachesAfterScreenshot).toEqual(["session-3"]);

    browser.emitEvent({
      method: "Page.navigatedWithinDocument",
      sessionId: "session-3",
      params: {
        frameId: "frame-main",
        url: `${browser.allowedOrigin}/ignored-detached-peer`,
        navigationType: "historyApi",
        timestamp: 40,
      },
    });
    browser.emitEvent({
      method: "Page.navigatedWithinDocument",
      sessionId: "session-1",
      params: {
        frameId: "frame-main",
        url: `${browser.allowedOrigin}/after-peer-detach`,
        navigationType: "historyApi",
        timestamp: 41,
      },
    });
    // Round-trip over the shared WebSocket so both queued server frames are
    // processed in FIFO order before releasing the held peer operations.
    const barrier = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
      }),
      { signal: controller.signal },
    );
    if (!barrier.ok) throw barrier.error;

    releasePeers();
    const [inspected, observed] = await Promise.all([inspecting, observing]);
    if (!inspected.ok) throw inspected.error;
    if (!observed.ok) throw observed.error;
    expect(inspected.value.target.origin).toBe(browser.allowedOrigin);
    expect(observed.value.window.end_reason).toBe("window_elapsed");
    expect(observed.value.timeline).toContainEqual(
      expect.objectContaining({
        type: "same_document_navigation",
        url: `${browser.allowedOrigin}/after-peer-detach`,
      }),
    );
    expect(observed.value.timeline).not.toContainEqual(
      expect.objectContaining({
        url: `${browser.allowedOrigin}/ignored-detached-peer`,
      }),
    );
    expect(browser.openedConnectionCount()).toBe(1);
    expect(browser.activeConnectionCount()).toBe(1);

    const allTargetSessions = new Set(
      browser.commands.flatMap((command) =>
        command.sessionId === undefined ? [] : [command.sessionId],
      ),
    );
    expect(allTargetSessions).toEqual(
      new Set(["session-1", "session-2", "session-3"]),
    );
    const allDetachedSessions = browser.commands
      .filter((command) => command.method === "Target.detachFromTarget")
      .map((command) => command.params.sessionId)
      .sort();
    expect(allDetachedSessions).toEqual([
      "session-1",
      "session-2",
      "session-3",
    ]);
  } finally {
    releasePeers();
    controller.abort(new Error("test teardown"));
    await Promise.allSettled([observing, inspecting, capturing]);
    await provider.close();
  }
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

it("reuses canonical browser sockets and keeps host and case-sensitive path identities distinct", async () => {
  const endpoints = [
    ["127.0.0.1", "127.0.0.1", "idA"],
    ["[::1]", "[0:0:0:0:0:0:0:1]", "idA"],
    ["127.0.0.1", "127.0.0.1", "idB"],
    ["127.0.0.1", "127.0.0.1", "IdA"],
  ] as const;
  const routes: {
    canonical: string;
    alias: string;
    browser: FakeCdpBrowser;
  }[] = [];
  let port: string | undefined;
  for (const [host, spelling, id] of endpoints) {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    port ??= new URL(browser.endpoint).port;
    const path = `/devtools/browser/${id}`;
    routes.push({
      canonical: `ws://${host}:${port}${path}`,
      alias: `WS://${spelling}:0${port}${path}`,
      browser,
    });
  }
  const wire = new Map(
    routes.map(({ canonical, browser }) => [
      canonical,
      browser.browserWebSocketUrl,
    ]),
  );
  const connect = CdpConnection.connect.bind(CdpConnection);
  // Route the normalized identities to separate loopback listeners. This also
  // lets the IPv6 identity be checked on hosts without IPv6 sockets.
  const dial = vi
    .spyOn(CdpConnection, "connect")
    .mockImplementation((url, ...rest) => {
      const target = wire.get(url);
      if (target === undefined)
        throw new Error(`Unexpected socket address: ${url}`);
      return connect(target, ...rest);
    });

  const provider = new CdpBrowserProvider();
  try {
    for (const { alias, browser } of routes) {
      const listed = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({ cdp_endpoint: alias }),
      );
      if (!listed.ok) throw listed.error;
      expect(listed.value.targets).toContainEqual(
        expect.objectContaining({
          target_id: "allowed-page",
          origin: browser.allowedOrigin,
        }),
      );
    }
    for (const { canonical, browser } of routes) {
      const inspected = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: canonical,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!inspected.ok) throw inspected.error;
      expect(inspected.value.target.origin).toBe(browser.allowedOrigin);
      expect(browser.openedConnectionCount()).toBe(1);
      expect(browser.activeConnectionCount()).toBe(1);
    }
    expect(dial.mock.calls.map(([url]) => url)).toEqual(
      routes.map(({ canonical }) => canonical),
    );
  } finally {
    dial.mockRestore();
    await provider.close();
  }
  await waitFor(() => {
    for (const { browser } of routes)
      expect(browser.activeConnectionCount()).toBe(0);
  });
});
