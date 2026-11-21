import { expect, it } from "vitest";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { phaseArrival } from "../../support/lifecycleHarness.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";
import { waitFor } from "../../support/testWait.js";

it.each([
  ["shared_worker", "detached"],
  ["worker", "detached"],
  ["shared_worker", "missing"],
  ["worker", "missing"],
  ["shared_worker", "rejected"],
  ["worker", "rejected"],
  ["shared_worker", "timeout"],
  ["worker", "timeout"],
] as const)(
  "reuses a browser socket only after confirmed explicit %s cleanup: %s",
  async (type, outcome) => {
    const workerSessionId = "explicit-worker-session";
    const browser = await startFakeCdpBrowser({
      commandResult(command, origin) {
        if (command.method === "Target.getTargets")
          return {
            targetInfos: [
              {
                targetId: "allowed-page",
                type: "page",
                title: "Page",
                url: origin + "/app",
                attached: false,
              },
              {
                targetId: "explicit-worker",
                type,
                title: "Worker",
                url: origin + "/worker.js",
                attached: false,
                openerId: "another-page",
              },
            ],
          };
        if (
          command.method === "Target.attachToTarget" &&
          command.params.targetId === "explicit-worker"
        )
          return { sessionId: workerSessionId };
        if (
          command.method === "ServiceWorker.enable" ||
          command.method === "ServiceWorker.disable" ||
          command.method === "Target.setAutoAttach"
        )
          return {};
        return undefined;
      },
      commandEvents: ({ method, sessionId }) =>
        method === "Target.setAutoAttach" || sessionId === workerSessionId
          ? []
          : undefined,
      commandError: ({ method, params }) => {
        if (
          method !== "Target.detachFromTarget" ||
          params.sessionId !== workerSessionId
        )
          return undefined;
        if (outcome === "missing")
          return { code: -32_001, message: "Session with given id not found." };
        if (outcome === "rejected")
          return { code: -32_000, message: "Detach rejected" };
        return undefined;
      },
      hangOnCommand: ({ method, params }) =>
        outcome === "timeout" &&
        method === "Target.detachFromTarget" &&
        params.sessionId === workerSessionId,
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    try {
      const result = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          worker_target_ids: ["explicit-worker"],
          observation_ms: 0,
        }),
      );
      if (!result.ok) throw result.error;
      expect(
        browser.commands.some(
          ({ method, sessionId }) =>
            method === "Runtime.enable" && sessionId === workerSessionId,
        ),
      ).toBe(true);
      const detachments = browser.commands.filter(
        ({ method }) => method === "Target.detachFromTarget",
      );
      expect(detachments.map(({ params }) => params.sessionId)).toContain(
        workerSessionId,
      );
      expect(
        detachments.some(({ params }) => params.sessionId !== workerSessionId),
      ).toBe(true);
      const mustClose = outcome === "rejected" || outcome === "timeout";
      await waitFor(() =>
        expect(browser.activeConnectionCount()).toBe(mustClose ? 0 : 1),
      );

      const next = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!next.ok) throw next.error;
      expect(next.value.target.origin).toBe(browser.allowedOrigin);
      expect(browser.openedConnectionCount()).toBe(mustClose ? 2 : 1);
      expect(browser.activeConnectionCount()).toBe(1);
    } finally {
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  },
);

it.each(["worker", "iframe"] as const)(
  "keeps a parallel browser lease alive after an auto-attached %s is already gone",
  async (type) => {
    const childSessionId = "auto-child-session";
    let autoDetached = false;
    let reportedGone = false;
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "ServiceWorker.enable" ||
        method === "ServiceWorker.disable" ||
        method === "Target.setAutoAttach"
          ? {}
          : undefined,
      commandEvents(command, origin) {
        if (
          command.method !== "Target.setAutoAttach" ||
          command.sessionId === childSessionId
        )
          return command.sessionId === childSessionId ? [] : undefined;
        if (command.params.autoAttach === true)
          return [
            {
              method: "Target.attachedToTarget",
              sessionId: command.sessionId,
              params: {
                sessionId: childSessionId,
                targetInfo: {
                  targetId: "auto-child",
                  type,
                  url: origin + "/child",
                  attached: true,
                  openerId: "allowed-page",
                },
                waitingForDebugger: false,
              },
            },
          ];
        autoDetached = true;
        return [
          {
            method: "Target.detachedFromTarget",
            sessionId: command.sessionId,
            params: { sessionId: childSessionId },
          },
        ];
      },
      commandError: ({ method, params }) => {
        if (
          method !== "Target.detachFromTarget" ||
          params.sessionId !== childSessionId ||
          !autoDetached
        )
          return undefined;
        reportedGone = true;
        return { code: -32_602, message: "No session with given id" };
      },
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const observationStart = phaseArrival();
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
              if (update.completed === 1) observationStart.arrive();
            },
          },
        },
      );
      await observationStart.reached(observing, "peer observation start");
      const peerSessionId = browser.commands.find(
        ({ method }) => method === "Performance.getMetrics",
      )?.sessionId;
      expect(peerSessionId).toBeDefined();

      const inspected = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.browserWebSocketUrl,
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!inspected.ok) throw inspected.error;
      expect(reportedGone).toBe(true);
      expect(browser.openedConnectionCount()).toBe(1);
      expect(browser.activeConnectionCount()).toBe(1);

      // The other lease can still receive an event and finish through its own
      // target lifecycle, rather than being disconnected by capture cleanup.
      browser.emitEvent({
        method: "Inspector.targetCrashed",
        sessionId: peerSessionId,
        params: {},
      });
      const observed = await observing;
      if (!observed.ok) throw observed.error;
      expect(observed.value.window.end_reason).toBe("target_terminated");
      expect(browser.activeConnectionCount()).toBe(1);
    } finally {
      controller.abort(new Error("test teardown"));
      await observing?.catch(() => undefined);
      await provider.close();
    }
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
  },
);
