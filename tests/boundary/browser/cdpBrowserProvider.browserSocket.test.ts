import { createServer, type Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

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
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
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
    const browser = await startFakeCdpBrowser({
      hangOnMethod: "Page.enable",
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    try {
      const listed = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
        }),
      );
      if (!listed.ok) throw listed.error;
      expect(browser.openedConnectionCount()).toBe(1);

      const timedOut = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
          command_timeout_ms: 60,
        }),
      );
      expect(timedOut).toMatchObject({
        ok: false,
        error: {
          _tag: "BrowserObservationError",
          operation: "inspect_web_page",
          reason: "timeout",
        },
      });
      if (timedOut.ok) throw new Error("Expected command timeout");
      expect(timedOut.error.userMessage).toContain("60 ms command_timeout_ms");
      expect(browser.openedConnectionCount()).toBe(1);
    } finally {
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });
});

it("retains browser-socket siblings and reports invalid attachment as unknown, not omitted", async () => {
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
                targetId: 1,
                type: "page",
                url: "https://example.test/invalid",
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
    const limitations = result.value.limitations.join("\n");
    expect(limitations).toContain(
      'reported malformed attached metadata "unknown"',
    );
    expect(limitations).toContain("reported malformed title metadata 3");
    expect(
      result.value.limitations.filter((item) =>
        item.includes("target identity is malformed"),
      ),
    ).toHaveLength(2);
    expect(limitations).not.toContain("omitted attachment");
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

  it("rejects malformed browser-socket discovery and closes the socket", async () => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Browser.getVersion"
          ? { product: "FakeChrome/1.0" }
          : undefined,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "list_browser_targets",
        reason: "invalid_endpoint_response",
      },
    });
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
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

/** Expect a discovery timeout that projects publicly as a provider timeout. */
const expectDiscoveryTimeout = async (url: string): Promise<void> => {
  let failure: unknown;
  try {
    await openCdpEndpoint(
      browserObservationEndpointSchema.parse(url),
      "list_browser_targets",
      undefined,
      50,
    );
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "timeout",
  });
  if (!(failure instanceof AnalysisError))
    throw new Error("Expected a typed discovery failure");
  expect(projectAnalysisError(failure)).toMatchObject({
    code: "provider_timeout",
    category: "timeout",
  });
};

describe("CdpBrowserProvider: browser socket discovery deadline", () => {
  it("times out a discovery reply that never arrives and closes the socket", async () => {
    const browser = await startFakeCdpBrowser({
      hangOnMethod: "Target.getTargets",
    });
    trackBrowser(browser);
    await expectDiscoveryTimeout(browser.browserWebSocketUrl);
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });

  it("times out a WebSocket handshake that never completes", async () => {
    const sockets = new Set<Socket>();
    // Read the upgrade request but never answer it; reading lets the
    // client's close be observed here.
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.resume();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected a TCP listener address");
    try {
      await expectDiscoveryTimeout(
        `ws://127.0.0.1:${String(address.port)}/devtools/browser/stalled`,
      );
      await waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("CdpBrowserProvider: shared browser socket lifecycle regressions", () => {
  it("closes a shared browser socket immediately when detach fails alongside an active observation", async () => {
    const browser = await startFakeCdpBrowser({
      commandError: ({ method }) =>
        method === "Target.detachFromTarget"
          ? { code: -32_000, message: "Detach rejected" }
          : undefined,
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const closeSpy = vi.spyOn(CdpConnection.prototype, "close");
    let armed!: () => void;
    const observationArmed = new Promise<void>((resolve) => {
      armed = resolve;
    });
    const controller = new AbortController();
    let observing: ReturnType<CdpBrowserProvider["observeSession"]> | undefined;
    try {
      observing = provider.observeSession(
        observeWebSessionInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 15_000,
        }),
        {
          signal: controller.signal,
          progress: {
            report: async (update) => {
              if (update.completed === 1) armed();
            },
          },
        },
      );
      await awaitAcknowledgement(
        observationArmed,
        observing,
        "peer session observation start",
      );
      expect(browser.openedConnectionCount()).toBe(1);
      expect(browser.activeConnectionCount()).toBe(1);

      const inspected = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!inspected.ok) throw inspected.error;
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(browser.openedConnectionCount()).toBe(1);
      await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));

      const session = await observing;
      if (!session.ok) throw session.error;
      expect(session.value.window.end_reason).toBe("transport_disconnected");
    } finally {
      controller.abort(new Error("test teardown"));
      await observing?.catch(() => undefined);
      closeSpy.mockRestore();
      await provider.close();
    }
  });

  it("surfaces cleanupIncomplete when forced shared-socket close fails after detach rejection", async () => {
    const browser = await startFakeCdpBrowser({
      commandError: ({ method }) =>
        method === "Target.detachFromTarget"
          ? { code: -32_000, message: "Detach rejected" }
          : undefined,
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const originalClose = CdpConnection.prototype.close;
    let denyClose = false;
    const closeSpy = vi
      .spyOn(CdpConnection.prototype, "close")
      .mockImplementation(function (this: CdpConnection) {
        return denyClose
          ? Promise.reject(new Error("controlled shared socket close failure"))
          : originalClose.call(this);
      });
    let armed!: () => void;
    const observationArmed = new Promise<void>((resolve) => {
      armed = resolve;
    });
    const controller = new AbortController();
    let observing: ReturnType<CdpBrowserProvider["observeSession"]> | undefined;
    try {
      observing = provider.observeSession(
        observeWebSessionInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 15_000,
        }),
        {
          signal: controller.signal,
          progress: {
            report: async (update) => {
              if (update.completed === 1) armed();
            },
          },
        },
      );
      await awaitAcknowledgement(
        observationArmed,
        observing,
        "peer session observation start",
      );
      denyClose = true;
      const inspected = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (inspected.ok)
        throw new Error("Expected incomplete transport cleanup");
      expect(inspected.error.cleanupIncomplete).toBe(true);
      expect(inspected.error.partialObservation).toBeDefined();

      controller.abort(new Error("end peer observation"));
      await observing;
      denyClose = false;
      await provider.close();
      expect(inspected.error.cleanupIncomplete).toBe(false);
      await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    } finally {
      denyClose = false;
      controller.abort(new Error("test teardown"));
      await observing?.catch(() => undefined);
      closeSpy.mockRestore();
      await provider.close();
    }
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
  const browser = await startFakeCdpBrowser({
    commandError: ({ method }) =>
      method === "Target.detachFromTarget"
        ? { code: -32_000, message: "Detach rejected" }
        : undefined,
  });
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const originalClose = CdpConnection.prototype.close;
  let denyClose = false;
  const closeSpy = vi
    .spyOn(CdpConnection.prototype, "close")
    .mockImplementation(function (this: CdpConnection) {
      return denyClose
        ? Promise.reject(new Error("controlled shared socket close failure"))
        : originalClose.call(this);
    });
  let armed!: () => void;
  const observationArmed = new Promise<void>((resolve) => {
    armed = resolve;
  });
  const controller = new AbortController();
  let observing: ReturnType<CdpBrowserProvider["observeSession"]> | undefined;
  try {
    observing = provider.observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
        target_id: "allowed-page",
        observation_ms: 15_000,
      }),
      {
        signal: controller.signal,
        progress: {
          report: async (update) => {
            if (update.completed === 1) armed();
          },
        },
      },
    );
    await awaitAcknowledgement(
      observationArmed,
      observing,
      "peer session observation start",
    );
    expect(browser.openedConnectionCount()).toBe(1);

    denyClose = true;
    const failedInspect = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (failedInspect.ok)
      throw new Error("Expected failed forced shared-socket close");
    expect(failedInspect.error.cleanupIncomplete).toBe(true);
    expect(browser.openedConnectionCount()).toBe(1);

    // Peer observation is still active; Call C must NOT bypass the unresolved close failure.
    const blocked = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
      }),
    );
    if (blocked.ok)
      throw new Error("Expected admission blocked on failed cleanup");
    expect(blocked.error.cleanupIncomplete).toBe(true);
    expect(browser.openedConnectionCount()).toBe(1);

    // Allow close retry to succeed while peer observation is still unwinding.
    denyClose = false;
    const recovered = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
      }),
    );
    if (!recovered.ok) throw recovered.error;
    expect(failedInspect.error.cleanupIncomplete).toBe(false);
    expect(blocked.error.cleanupIncomplete).toBe(false);
    expect(browser.openedConnectionCount()).toBe(2);

    const session = await observing;
    if (!session.ok) throw session.error;
    expect(session.value.window.end_reason).toBe("transport_disconnected");
  } finally {
    denyClose = false;
    controller.abort(new Error("test teardown"));
    await observing?.catch(() => undefined);
    closeSpy.mockRestore();
    await provider.close();
  }
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

it("keeps an admitted shared browser socket alive for concurrent peers when a caller aborts or hits discovery_timeout_ms", async () => {
  let slowTargetDiscovery = false;
  let notifySlowDiscoveryStarted: (() => void) | undefined;
  const browser = await startFakeCdpBrowser({
    commandDelayMs: ({ method }) => {
      if (!slowTargetDiscovery || method !== "Target.getTargets")
        return undefined;
      notifySlowDiscoveryStarted?.();
      return 200;
    },
  });
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  let armed!: () => void;
  const observationArmed = new Promise<void>((resolve) => {
    armed = resolve;
  });
  const peerController = new AbortController();
  const cancelController = new AbortController();
  let observing: ReturnType<CdpBrowserProvider["observeSession"]> | undefined;
  let cancelling: ReturnType<CdpBrowserProvider["listTargets"]> | undefined;
  try {
    observing = provider.observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
        target_id: "allowed-page",
        observation_ms: 400,
      }),
      {
        signal: peerController.signal,
        progress: {
          report: async (update) => {
            if (update.completed === 1) armed();
          },
        },
      },
    );
    await awaitAcknowledgement(
      observationArmed,
      observing,
      "peer session observation start",
    );
    expect(browser.openedConnectionCount()).toBe(1);

    slowTargetDiscovery = true;
    const timedOut = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
        target_id: "allowed-page",
        observation_ms: 0,
        discovery_timeout_ms: 35,
      }),
    );
    expect(timedOut).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "inspect_web_page",
        reason: "timeout",
      },
    });
    if (timedOut.ok) throw new Error("Expected discovery timeout on Call B");
    expect(timedOut.error.userMessage).toContain("35 ms discovery_timeout_ms");
    expect(browser.openedConnectionCount()).toBe(1);
    expect(browser.activeConnectionCount()).toBe(1);

    let enterCancelDiscovery!: () => void;
    const cancelDiscoveryEntered = new Promise<void>((resolve) => {
      enterCancelDiscovery = resolve;
    });
    notifySlowDiscoveryStarted = enterCancelDiscovery;
    cancelling = provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.browserWebSocketUrl,
      }),
      { signal: cancelController.signal },
    );
    await awaitAcknowledgement(
      cancelDiscoveryEntered,
      cancelling,
      "shared socket discovery start",
    );
    cancelController.abort(new Error("caller cancelled discovery"));
    expect(await cancelling).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "list_browser_targets",
      },
    });

    slowTargetDiscovery = false;
    const session = await observing;
    if (!session.ok) throw session.error;
    expect(session.value.window.end_reason).toBe("window_elapsed");
    expect(browser.openedConnectionCount()).toBe(1);
    expect(browser.activeConnectionCount()).toBe(1);
  } finally {
    slowTargetDiscovery = false;
    peerController.abort(new Error("test teardown"));
    cancelController.abort(new Error("test teardown"));
    await Promise.allSettled([observing, cancelling]);
    await provider.close();
  }
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

describe("CdpBrowserProvider: coalesced cold-start browser sockets", () => {
  it("coalesces concurrent cold-start calls onto one browser WebSocket handshake", async () => {
    const browser = await startFakeCdpBrowser({ handshakeDelayMs: 40 });
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
      await batch?.catch(() => undefined);
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });

  it("keeps an in-flight cold-start handshake alive for a longer-deadline peer when one waiter times out", async () => {
    const browser = await startFakeCdpBrowser({ handshakeDelayMs: 120 });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    let shortCall: ReturnType<CdpBrowserProvider["listTargets"]> | undefined;
    let longCall: ReturnType<CdpBrowserProvider["inspectPage"]> | undefined;
    try {
      shortCall = provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          discovery_timeout_ms: 35,
        }),
      );
      longCall = provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
          discovery_timeout_ms: 5_000,
        }),
      );

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
        "35 ms discovery_timeout_ms",
      );

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
      await Promise.allSettled([shortCall, longCall]);
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  });
});

const createDeferredGate = (): {
  readonly promise: Promise<void>;
  readonly open: () => void;
} => {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const holdProgressStep = (
  step: number,
  entered: () => void,
  release: Promise<void>,
) => ({
  async report(update: { readonly completed: number }) {
    if (update.completed === step) {
      entered();
      await release;
    }
  },
});

it("isolates concurrent target sessions on one shared browser socket when a shorter call detaches first", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const controller = new AbortController();
  const observationArmed = createDeferredGate();
  const inspectionHeld = createDeferredGate();
  const peersGate = createDeferredGate();
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
        progress: holdProgressStep(1, observationArmed.open, peersGate.promise),
      },
    );
    await awaitAcknowledgement(
      observationArmed.promise,
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
        progress: holdProgressStep(2, inspectionHeld.open, peersGate.promise),
      },
    );
    await awaitAcknowledgement(
      inspectionHeld.promise,
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

    peersGate.open();
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
    peersGate.open();
    controller.abort(new Error("test teardown"));
    await Promise.allSettled([observing, inspecting, capturing]);
    await provider.close();
  }
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

it("reuses one browser socket across equivalent normalized spellings while keeping 127.0.0.1 and [::1] distinct", async () => {
  const ipv4Browser = await startFakeCdpBrowser();
  const ipv6Browser = await startFakeCdpBrowser();
  trackBrowser(ipv4Browser);
  trackBrowser(ipv6Browser);
  const port = new URL(ipv4Browser.endpoint).port;
  const canonicalIpv6Url = `ws://[::1]:${port}/devtools/browser/fake`;
  const originalConnect = CdpConnection.connect.bind(CdpConnection);
  const connectUrls: string[] = [];
  const connectSpy = vi
    .spyOn(CdpConnection, "connect")
    .mockImplementation((url, ...rest) => {
      connectUrls.push(url);
      const wireUrl =
        url === canonicalIpv6Url ? ipv6Browser.browserWebSocketUrl : url;
      return originalConnect(wireUrl, ...rest);
    });
  const provider = new CdpBrowserProvider();
  try {
    const ipv6Listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: `WS://[0:0:0:0:0:0:0:1]:0${port}/devtools/browser/fake`,
      }),
    );
    if (!ipv6Listed.ok) throw ipv6Listed.error;
    const ipv6Inspected = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: canonicalIpv6Url,
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!ipv6Inspected.ok) throw ipv6Inspected.error;
    expect(ipv6Browser.openedConnectionCount()).toBe(1);
    expect(ipv4Browser.openedConnectionCount()).toBe(0);

    const ipv4Listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: `WS://127.0.0.1:0${port}/devtools/browser/fake`,
      }),
    );
    if (!ipv4Listed.ok) throw ipv4Listed.error;
    const ipv4Screenshot = await provider.captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: ipv4Browser.browserWebSocketUrl,
        target_id: "allowed-page",
      }),
    );
    if (!ipv4Screenshot.ok) throw ipv4Screenshot.error;

    expect(ipv6Browser.openedConnectionCount()).toBe(1);
    expect(ipv4Browser.openedConnectionCount()).toBe(1);
    expect(ipv6Browser.activeConnectionCount()).toBe(1);
    expect(ipv4Browser.activeConnectionCount()).toBe(1);
    expect(connectUrls).toEqual([
      canonicalIpv6Url,
      ipv4Browser.browserWebSocketUrl,
    ]);
  } finally {
    connectSpy.mockRestore();
    await provider.close();
  }
  await waitFor(() => {
    expect(ipv6Browser.activeConnectionCount()).toBe(0);
    expect(ipv4Browser.activeConnectionCount()).toBe(0);
  });
});

it("keeps distinct /devtools/browser/<id> paths on separate browser sockets while reusing each normalized path", async () => {
  const browserA = await startFakeCdpBrowser();
  const browserB = await startFakeCdpBrowser();
  const browserCaseA = await startFakeCdpBrowser();
  trackBrowser(browserA);
  trackBrowser(browserB);
  trackBrowser(browserCaseA);
  const port = new URL(browserA.endpoint).port;
  const canonicalIdAUrl = `ws://127.0.0.1:${port}/devtools/browser/idA`;
  const canonicalIdBUrl = `ws://127.0.0.1:${port}/devtools/browser/idB`;
  const canonicalCaseIdAUrl = `ws://127.0.0.1:${port}/devtools/browser/IdA`;
  const routedWireUrls = new Map<string, string>([
    [canonicalIdAUrl, browserA.browserWebSocketUrl],
    [canonicalIdBUrl, browserB.browserWebSocketUrl],
    [canonicalCaseIdAUrl, browserCaseA.browserWebSocketUrl],
  ]);
  const originalConnect = CdpConnection.connect.bind(CdpConnection);
  const connectUrls: string[] = [];
  const connectSpy = vi
    .spyOn(CdpConnection, "connect")
    .mockImplementation((url, ...rest) => {
      connectUrls.push(url);
      const wireUrl = routedWireUrls.get(url);
      if (wireUrl === undefined) {
        throw new Error(`Unexpected unmapped browser socket URL: ${url}`);
      }
      return originalConnect(wireUrl, ...rest);
    });
  const provider = new CdpBrowserProvider();
  try {
    const firstIdAListed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: canonicalIdAUrl,
      }),
    );
    if (!firstIdAListed.ok) throw firstIdAListed.error;

    const firstIdBListed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: canonicalIdBUrl,
      }),
    );
    if (!firstIdBListed.ok) throw firstIdBListed.error;

    const secondIdAInspected = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: canonicalIdAUrl,
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!secondIdAInspected.ok) throw secondIdAInspected.error;

    const leadingZeroIdBListed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: `WS://127.0.0.1:0${port}/devtools/browser/idB`,
      }),
    );
    if (!leadingZeroIdBListed.ok) throw leadingZeroIdBListed.error;

    const caseDistinctListed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: canonicalCaseIdAUrl,
      }),
    );
    if (!caseDistinctListed.ok) throw caseDistinctListed.error;

    const caseDistinctScreenshot = await provider.captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: `WS://127.0.0.1:0${port}/devtools/browser/IdA`,
        target_id: "allowed-page",
      }),
    );
    if (!caseDistinctScreenshot.ok) throw caseDistinctScreenshot.error;

    expect(browserA.openedConnectionCount()).toBe(1);
    expect(browserB.openedConnectionCount()).toBe(1);
    expect(browserCaseA.openedConnectionCount()).toBe(1);
    expect(browserA.activeConnectionCount()).toBe(1);
    expect(browserB.activeConnectionCount()).toBe(1);
    expect(browserCaseA.activeConnectionCount()).toBe(1);
    expect(connectUrls).toEqual([
      canonicalIdAUrl,
      canonicalIdBUrl,
      canonicalCaseIdAUrl,
    ]);
  } finally {
    connectSpy.mockRestore();
    await provider.close();
  }
  await waitFor(() => {
    expect(browserA.activeConnectionCount()).toBe(0);
    expect(browserB.activeConnectionCount()).toBe(0);
    expect(browserCaseA.activeConnectionCount()).toBe(0);
  });
});
