import { createServer } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";
import { expect, it, onTestFinished, vi } from "vitest";
import { phaseArrival, phaseGate } from "../../support/lifecycleHarness.js";

import { CdpTargetSessionOwner } from "../../../src/browser/CdpTargetSessionOwner.js";
import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { waitFor } from "../../support/testWait.js";

it.each(["connect", "acquireBrowserSocket"] as const)(
  "refuses %s after clean shutdown without inventing retained cleanup",
  async (method) => {
    const owner = new CdpTargetSessionOwner();
    await owner.close();
    const endpoint = "ws://127.0.0.1:9/devtools/browser/closed";
    const failure = await (
      method === "connect"
        ? owner.connect(endpoint, "inspect_web_page", {}, "not-acquired")
        : owner.acquireBrowserSocket(
            endpoint,
            "inspect_web_page",
            {},
            {
              commandTimeoutMs: 100,
              handshakeTimeoutMs: 100,
            },
          )
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisCapabilityUnavailableError);
    expect(failure).toMatchObject({
      providerId: "rea-cdp-browser",
      operation: "inspect_web_page",
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    await owner.close();
  },
);

it("joins a late owned handshake and waits for its active operation", async () => {
  const http = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  let port = 0;
  const lateUpgrade = phaseGate();
  http.on("upgrade", (request, socket, head) => {
    void lateUpgrade
      .hold()
      .then(() =>
        webSockets.handleUpgrade(request, socket, head, (webSocket) =>
          webSockets.emit("connection", webSocket, request),
        ),
      );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture did not bind a TCP port");
  port = address.port;
  const owner = new CdpTargetSessionOwner();
  let connecting: Promise<CdpConnection> | undefined;
  onTestFinished(async () => {
    lateUpgrade.release();
    if (connecting !== undefined) {
      const pendingConnection = await connecting;
      await owner.finish(pendingConnection);
    }
    await owner.close();
    await new Promise<void>((resolve, reject) =>
      webSockets.close((cause) => (cause ? reject(cause) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      http.close((cause) => (cause ? reject(cause) : resolve())),
    );
  });

  connecting = owner.connect(
    `ws://127.0.0.1:${String(port)}/devtools/browser/late`,
    "inspect_web_page",
    {},
    "late-handshake",
  );
  await lateUpgrade.reached(connecting, "late WebSocket upgrade");
  const closing = owner.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  lateUpgrade.release();
  const connection = await connecting;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  await owner.finish(connection);
  await closing;
  await waitFor(() => expect(webSockets.clients.size).toBe(0));
});

it("retries only the failed transport and does not repeat successful child cleanup", async () => {
  const browser = await startFakeCdpBrowser();
  const owner = new CdpTargetSessionOwner();
  let active: CdpConnection | undefined;
  onTestFinished(async () => {
    if (active !== undefined) await owner.finish(active);
    await owner.close();
    await browser.close();
  });
  const failed = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "failed-session",
  );
  active = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "active-peer",
  );
  const close = vi
    .spyOn(WebSocket.prototype, "close")
    .mockImplementationOnce(() => {
      throw new Error("controlled close failure");
    });
  const terminate = vi
    .spyOn(WebSocket.prototype, "terminate")
    .mockImplementation(() => undefined);
  try {
    const failure = await owner.finish(failed).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ProviderCleanupError);
    expect(failure).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["failed-session"],
    });
  } finally {
    close.mockRestore();
    terminate.mockRestore();
  }

  await owner.retryPending();
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(1));
  const cleanup = vi.fn(async () => undefined);
  await owner.finish(active, cleanup);
  await owner.retryPending();
  await owner.close();
  expect(cleanup).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Target.closeTarget",
  );
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Browser.close",
  );
});

it("accepts asynchronous terminate success only after the close event", async () => {
  const browser = await startFakeCdpBrowser();
  const owner = new CdpTargetSessionOwner();
  onTestFinished(async () => {
    await owner.close();
    await browser.close();
  });
  const connection = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "forced-close",
  );
  const originalTerminate = WebSocket.prototype.terminate;
  const close = vi
    .spyOn(WebSocket.prototype, "close")
    .mockImplementation(() => undefined);
  const terminate = vi
    .spyOn(WebSocket.prototype, "terminate")
    .mockImplementation(function (this: WebSocket) {
      return originalTerminate.call(this);
    });
  try {
    await owner.finish(connection);
  } finally {
    close.mockRestore();
    terminate.mockRestore();
  }
  await owner.close();
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

it("clears returned inspection and shutdown cleanup status only after socket release", async () => {
  const browser = await startFakeCdpBrowser();
  const provider = new CdpBrowserProvider();
  const originalClose = CdpConnection.prototype.close;
  let denied = true;
  const closing = vi
    .spyOn(CdpConnection.prototype, "close")
    .mockImplementation(function (this: CdpConnection) {
      return denied
        ? Promise.reject(new Error("controlled transport close failure"))
        : originalClose.call(this);
    });
  onTestFinished(async () => {
    closing.mockRestore();
    await provider.close();
    await browser.close();
  });
  const result = await provider.inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (result.ok) throw new Error("Expected retained socket cleanup failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.partialObservation).toBeDefined();
  const observation = result.error.partialObservation;
  const retry = await provider.close().catch((cause: unknown) => cause);
  expect(retry).toBeInstanceOf(AnalysisError);
  if (!(retry instanceof AnalysisError))
    throw new Error("Missing retry failure");
  expect(retry.cleanupIncomplete).toBe(true);
  expect(browser.activeConnectionCount()).toBe(1);
  denied = false;
  await provider.close();
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(retry.cleanupIncomplete).toBe(false);
  expect(result.error.partialObservation).toBe(observation);
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Browser.close",
  );
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Target.closeTarget",
  );
});

it("keeps retry aggregates incomplete until every reported socket is released", async () => {
  const browser = await startFakeCdpBrowser();
  const owner = new CdpTargetSessionOwner();
  const first = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "first-socket",
  );
  const second = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "second-socket",
  );
  const active = await owner.connect(
    browser.browserWebSocketUrl,
    "inspect_web_page",
    {},
    "active-peer",
  );
  const originalClose = CdpConnection.prototype.close;
  const denied = new Set([first, second]);
  const closing = vi
    .spyOn(CdpConnection.prototype, "close")
    .mockImplementation(function (this: CdpConnection) {
      return denied.has(this)
        ? Promise.reject(new Error("controlled mixed close failure"))
        : originalClose.call(this);
    });
  onTestFinished(async () => {
    closing.mockRestore();
    await owner.finish(active);
    await owner.close();
    await browser.close();
  });
  const errors = await Promise.all(
    [first, second].map((connection) =>
      owner.finish(connection).catch((cause: unknown) => cause),
    ),
  );
  const aggregate = await owner.retryPending().catch((cause: unknown) => cause);
  if (
    !(aggregate instanceof AnalysisError) ||
    !errors.every((error) => error instanceof AnalysisError)
  )
    throw new Error("Missing typed cleanup errors");
  expect(aggregate.cleanupResources).toEqual(["first-socket", "second-socket"]);
  denied.delete(first);
  const mixed = await owner.retryPending().catch((cause: unknown) => cause);
  if (!(mixed instanceof AnalysisError))
    throw new Error("Missing mixed retry error");
  expect(errors.map((error) => error.cleanupIncomplete)).toEqual([false, true]);
  expect(aggregate.cleanupIncomplete).toBe(true);
  expect(mixed.cleanupResources).toEqual(["second-socket"]);
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(2));
  denied.clear();
  await owner.retryPending();
  expect(errors.map((error) => error.cleanupIncomplete)).toEqual([
    false,
    false,
  ]);
  expect(aggregate.cleanupIncomplete).toBe(false);
  expect(mixed.cleanupIncomplete).toBe(false);
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(1));
  await owner.finish(active);
});

it.each(["upgrade rejection", "last waiter cancellation"] as const)(
  "retains one cold socket cleanup failure after %s and clears its affected callers on retry",
  async (termination) => {
    const http = createServer();
    const sockets = new Set<Duplex>();
    const upgrade = phaseArrival<Duplex>();
    let upgrades = 0;
    http.on("upgrade", (_request, socket) => {
      upgrades += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      upgrade.arrive(socket);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture did not bind a TCP port");

    const owner = new CdpTargetSessionOwner();
    const originalClose = CdpConnection.prototype.close;
    const closeError = new Error("controlled cold socket close failure");
    let denyClose = true;
    const closeSpy = vi
      .spyOn(CdpConnection.prototype, "close")
      .mockImplementation(function (this: CdpConnection) {
        return denyClose
          ? Promise.reject(closeError)
          : originalClose.call(this);
      });
    const callers = [
      { controller: new AbortController(), operation: "list_browser_targets" },
      { controller: new AbortController(), operation: "inspect_web_page" },
    ] as const;
    const limits = { commandTimeoutMs: 5_000, handshakeTimeoutMs: 5_000 };
    const url = `ws://127.0.0.1:${String(address.port)}/devtools/browser/cold`;
    const pending = callers.map(({ controller, operation }) =>
      owner.acquireBrowserSocket(
        url,
        operation,
        { signal: controller.signal },
        limits,
      ),
    );
    const outcomes = pending.map((request) =>
      request.catch((cause: unknown) => cause),
    );

    onTestFinished(async () => {
      denyClose = false;
      for (const { controller } of callers) controller.abort();
      await Promise.allSettled(pending);
      closeSpy.mockRestore();
      try {
        await owner.close();
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          http.close((cause) => (cause ? reject(cause) : resolve())),
        );
      }
    });

    const socket = await upgrade.reached(
      Promise.race(pending),
      "cold browser-socket upgrade",
    );
    const cancellation = termination === "last waiter cancellation";
    const reasons = [
      new Error("first caller cancelled"),
      new Error("last caller cancelled"),
    ] as const;
    if (cancellation) {
      callers[0].controller.abort(reasons[0]);
      const firstError = await outcomes[0];
      if (!(firstError instanceof AnalysisCancelledError))
        throw new Error("Expected first waiter cancellation", {
          cause: firstError,
        });
      expect(firstError.cause).toBe(reasons[0]);
      expect(firstError.cleanupIncomplete).toBe(false);
      callers[1].controller.abort(reasons[1]);
    } else socket.destroy();

    const affected = cancellation ? ([1] as const) : ([0, 1] as const);
    const failures = await Promise.all(
      affected.map(async (index) => {
        const failure = await outcomes[index];
        if (!(failure instanceof AnalysisError))
          throw new Error(
            "Expected typed cleanup-incomplete handshake failure",
            { cause: failure },
          );
        expect(failure.cleanupIncomplete).toBe(true);
        expect(failure.cleanupResources).toEqual(["browser-endpoint"]);
        expect(failure.cleanupPrimary).toMatchObject({
          _tag: cancellation
            ? "AnalysisCancelledError"
            : "BrowserObservationError",
          operation: callers[index].operation,
        });
        if (cancellation)
          expect(failure.cleanupPrimary?.cause).toBe(reasons[1]);
        return failure;
      }),
    );
    expect(upgrades).toBe(1);
    await expect(owner.retryPending()).rejects.toBeInstanceOf(AnalysisError);
    denyClose = false;
    await owner.retryPending();
    for (const failure of failures)
      expect(failure.cleanupIncomplete).toBe(false);
    // Let the runner observe any abandoned rejection on the failed-close path.
    await new Promise<void>((resolve) => setImmediate(resolve));
  },
);
