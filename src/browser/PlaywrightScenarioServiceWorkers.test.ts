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
        : method === "Target.setAutoAttach" ||
            method === "Page.removeScriptToEvaluateOnNewDocument"
          ? {}
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
  } finally {
    await policy.close().catch(() => undefined);
    await browser.close();
  }
});
