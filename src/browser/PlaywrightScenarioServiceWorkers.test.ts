import { expect, it, vi } from "vitest";

import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../tests/fixtures/fakeCdpBrowser.js";
import { CdpConnection } from "./CdpConnection.js";
import { PlaywrightScenarioServiceWorkers } from "./PlaywrightScenarioServiceWorkers.js";

it.each([
  {
    kind: "duplicate",
    targetInfos: [
      { targetId: "target", type: "page", url: "https://allowed.test/" },
      { targetId: "target", type: "page", url: 42 },
    ],
  },
  {
    kind: "malformed duplicates",
    targetInfos: [
      { targetId: "target", type: "page" },
      { targetId: "target", type: "page", url: 42 },
    ],
  },
  { kind: "missing", targetInfos: [] },
  {
    kind: "duplicates with unconfirmed cleanup",
    targetInfos: [{ targetId: "target" }, { targetId: "target" }],
    refuseClose: true,
  },
])(
  "rejects $kind before attachment and releases the discovery socket",
  async ({ kind, targetInfos, refuseClose }) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Target.getTargets" ? { targetInfos } : undefined,
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
    const close = refuseClose
      ? vi
          .spyOn(CdpConnection.prototype, "close")
          .mockRejectedValueOnce(new Error("socket close failed"))
      : undefined;
    const discoveryFailure =
      kind === "missing"
        ? { reason: "target_not_found" }
        : {
            reason: "invalid_endpoint_response",
            detail: expect.stringContaining("ambiguous"),
          };
    try {
      const failure = await policy
        .initialize()
        .catch((cause: unknown) => cause);
      if (refuseClose) {
        expect(failure).toMatchObject({
          cleanupIncomplete: true,
          cleanupPrimary: discoveryFailure,
        });
        expect(browser.activeConnectionCount()).toBe(1);
        await policy.close();
        expect(failure).toMatchObject({ cleanupIncomplete: false });
      } else {
        expect(failure).toMatchObject(discoveryFailure);
      }
      await expect.poll(() => browser.activeConnectionCount()).toBe(0);
      expect(browser.commands.map(({ method }) => method)).toEqual([
        "Browser.getVersion",
        "Target.getTargets",
      ]);
    } finally {
      close?.mockRestore();
      await policy.close().finally(() => browser.close());
    }
  },
);

const startPolicyFixture = async (
  wire: Pick<FakeOptions, "commandEvents" | "eventsBeforeReply"> = {},
) => {
  const browser = await startFakeCdpBrowser({
    ...wire,
    commandResult: ({ method }) => {
      switch (method) {
        case "Page.addScriptToEvaluateOnNewDocument":
          return { identifier: "policy-script" };
        case "Runtime.evaluate":
          return { result: { type: "object", value: null } };
        case "Target.setAutoAttach":
        case "Page.removeScriptToEvaluateOnNewDocument":
          return {};
        default:
          return undefined;
      }
    },
  });
  const policy = new PlaywrightScenarioServiceWorkers(
    {
      frames: () => [],
      isClosed: () => false,
      mainFrame: () => ({ evaluate: async () => null }) as never,
    },
    browser.browserWebSocketUrl,
    "allowed-page",
  );
  return { browser, policy };
};

it("reports a malformed target event the policy listener rejected at the next policy check", async () => {
  const { browser, policy } = await startPolicyFixture();
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
    // The failed connection remains available to remove future installation
    // before restoring the current realm and detaching.
    const beforeClose = browser.commands.length;
    await policy.close();
    expect(
      browser.commands.slice(beforeClose).map(({ method }) => method),
    ).toEqual([
      "Page.removeScriptToEvaluateOnNewDocument",
      "Runtime.evaluate",
      "Target.detachFromTarget",
    ]);
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
    const { browser, policy } = await startPolicyFixture();
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
  const { browser, policy } = await startPolicyFixture({
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
  try {
    await policy.initialize();
    await policy.close();
    expect(() => policy.assertConnected()).not.toThrow();
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  } finally {
    await policy.close().catch(() => undefined);
    await browser.close();
  }
});
