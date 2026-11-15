import { expect, it, vi } from "vitest";

import { startFakeCdpBrowser } from "../../tests/fixtures/fakeCdpBrowser.js";
import { CdpConnection } from "./CdpConnection.js";
import { PlaywrightScenarioServiceWorkers } from "./PlaywrightScenarioServiceWorkers.js";

it.each(["duplicate", "malformed duplicates", "missing"])(
  "releases an opened browser socket before rejecting service-worker target discovery: %s",
  async (kind) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Target.getTargets"
          ? {
              targetInfos:
                kind === "missing"
                  ? []
                  : [
                      {
                        targetId: "target",
                        type: "page",
                        ...(kind === "duplicate"
                          ? { url: "https://allowed.test/" }
                          : {}),
                      },
                      { targetId: "target", type: "page", url: 42 },
                    ],
            }
          : undefined,
    });
    const policy = new PlaywrightScenarioServiceWorkers(
      {
        frames: () => [],
        isClosed: () => false,
        mainFrame: () => {
          throw new Error("No frame mutation expected");
        },
      },
      browser.browserWebSocketUrl,
      "target",
    );
    try {
      await expect(policy.initialize()).rejects.toMatchObject({
        reason:
          kind === "missing" ? "target_not_found" : "invalid_endpoint_response",
        ...(kind === "missing"
          ? {}
          : { detail: expect.stringContaining("ambiguous") }),
      });
      await expect.poll(() => browser.activeConnectionCount()).toBe(0);
      await policy.close();
      expect(browser.commands.map(({ method }) => method)).toEqual([
        "Browser.getVersion",
        "Target.getTargets",
      ]);
    } finally {
      await policy.close();
      await browser.close();
    }
  },
);

it("retains ownership and retries socket cleanup after ambiguous service-worker discovery", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "target" }, { targetId: "target" }] }
        : undefined,
  });
  const policy = new PlaywrightScenarioServiceWorkers(
    {
      frames: () => [],
      isClosed: () => false,
      mainFrame: () => {
        throw new Error("No frame mutation expected");
      },
    },
    browser.browserWebSocketUrl,
    "target",
  );
  const cleanupFailure = new Error("socket close failed");
  const close = vi
    .spyOn(CdpConnection.prototype, "close")
    .mockRejectedValueOnce(cleanupFailure);
  try {
    await expect(policy.initialize()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    await policy.close();
    expect(close).toHaveBeenCalledTimes(2);
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
    expect(browser.commands.map(({ method }) => method)).toEqual([
      "Browser.getVersion",
      "Target.getTargets",
    ]);
  } finally {
    close.mockRestore();
    await policy.close();
    await browser.close();
  }
});

it("reports a malformed target event the policy listener rejected at the next policy check", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Page.addScriptToEvaluateOnNewDocument"
        ? { identifier: "policy-script" }
        : method === "Runtime.evaluate"
          ? { result: { type: "object", value: null } }
          : method === "Target.setAutoAttach" ||
              method === "Page.removeScriptToEvaluateOnNewDocument"
            ? {}
            : undefined,
  });
  const policy = new PlaywrightScenarioServiceWorkers(
    {
      frames: () => [],
      isClosed: () => false,
      mainFrame: () => ({}) as never,
    },
    browser.browserWebSocketUrl,
    "allowed-page",
  );
  try {
    await policy.initialize();
    await policy.assertBlocked();
    // No policy command is pending: only the recorded failure can surface it.
    browser.emitEvent({ method: "Target.detachedFromTarget", params: {} });
    await expect
      .poll(() =>
        policy.assertBlocked().then(
          () => "passed",
          (cause: unknown) => cause,
        ),
      )
      .toMatchObject({
        _tag: "BrowserObservationError",
        reason: "protocol_error",
        cause: expect.objectContaining({ reason: "protocol_error" }),
      });
    // Cleanup still runs on the failed connection in its grace period.
    await policy.close();
    expect(browser.commands.map(({ method }) => method)).toEqual(
      expect.arrayContaining([
        "Page.removeScriptToEvaluateOnNewDocument",
        "Runtime.evaluate",
        "Target.detachFromTarget",
      ]),
    );
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  } finally {
    await policy.close().catch(() => undefined);
    await browser.close();
  }
});

// A dropped policy connection is recorded when CDP reports it, so the next
// step reports it before acting, rather than when a later document turns out
// to be unprotected.
it.each(["the policy session detaches", "the policy socket closes"] as const)(
  "reports a lost policy connection as soon as %s",
  async (loss) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.addScriptToEvaluateOnNewDocument"
          ? { identifier: "policy-script" }
          : method === "Target.setAutoAttach"
            ? {}
            : undefined,
    });
    const policy = new PlaywrightScenarioServiceWorkers(
      {
        frames: () => [],
        isClosed: () => false,
        mainFrame: () => ({}) as never,
      },
      browser.browserWebSocketUrl,
      "allowed-page",
    );
    try {
      await policy.initialize();
      expect(() => policy.assertConnected()).not.toThrow();
      const sessionId = browser.commands.find(
        (command) => command.sessionId !== undefined,
      )?.sessionId;
      if (sessionId === undefined) throw new Error("Expected a policy session");
      if (loss === "the policy session detaches")
        browser.emitEvent({
          method: "Target.detachedFromTarget",
          params: { sessionId, targetId: "allowed-page" },
        });
      else browser.closeActiveConnections();
      const reason =
        loss === "the policy session detaches"
          ? "target_session_detached"
          : "disconnected";
      // No policy command is pending: only the recorded loss can surface it.
      await expect
        .poll(() => {
          try {
            policy.assertConnected();
            return "connected";
          } catch (cause: unknown) {
            return cause;
          }
        })
        .toMatchObject({ _tag: "BrowserObservationError", reason });
      await expect(policy.assertBlocked()).rejects.toMatchObject({ reason });
    } finally {
      await policy.close().catch(() => undefined);
      await browser.close();
    }
  },
);

it("does not report its own policy session detachment during cleanup as a loss", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Page.addScriptToEvaluateOnNewDocument"
        ? { identifier: "policy-script" }
        : method === "Runtime.evaluate"
          ? { result: { type: "object", value: null } }
          : method === "Target.setAutoAttach" ||
              method === "Page.removeScriptToEvaluateOnNewDocument"
            ? {}
            : undefined,
    commandEvents: (command) =>
      command.method === "Target.detachFromTarget"
        ? [
            {
              method: "Target.detachedFromTarget",
              params: {
                sessionId: command.params.sessionId,
                targetId: "allowed-page",
              },
            },
          ]
        : undefined,
    eventsBeforeReply: ["Target.detachFromTarget"],
  });
  const policy = new PlaywrightScenarioServiceWorkers(
    {
      frames: () => [],
      isClosed: () => false,
      mainFrame: () => ({}) as never,
    },
    browser.browserWebSocketUrl,
    "allowed-page",
  );
  try {
    await policy.initialize();
    await policy.close();
    expect(() => policy.assertConnected()).not.toThrow();
  } finally {
    await policy.close().catch(() => undefined);
    await browser.close();
  }
});
