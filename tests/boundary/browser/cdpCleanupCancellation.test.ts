import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it, onTestFinished, vi } from "vitest";

import { CdpCommandRejection } from "../../../src/browser/CdpCommandRejection.js";
import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { inspectElectronPageInputSchema } from "../../../src/domain/javascript/electronObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import { phaseArrival } from "../../support/lifecycleHarness.js";
import { waitFor } from "../../support/testWait.js";

const releaseFixture = (
  provider: CdpBrowserProvider | CdpElectronProvider,
  browser: FakeCdpBrowser,
) =>
  onTestFinished(async () => {
    if (vi.isFakeTimers()) vi.useRealTimers();
    try {
      await provider.close();
    } finally {
      await browser.close();
    }
  });

const expectReleasedSession = async (browser: FakeCdpBrowser) => {
  const methods = browser.commands.map(({ method }) => method);
  expect(methods).toContain("Target.detachFromTarget");
  expect(methods).not.toContain("Target.closeTarget");
  expect(methods).not.toContain("Browser.close");
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
};

it.each([
  {
    name: "skips optional domain shutdown for an already cancelled session",
    hangOnMethod: "Page.disable",
  },
  {
    name: "closes a cancelled session when the detach reply never arrives",
    hangOnMethod: "Target.detachFromTarget",
  },
])("$name", async ({ hangOnMethod }) => {
  const detach = phaseArrival();
  const browser = await startFakeCdpBrowser({
    hangOnMethod,
    commandError({ method }) {
      if (method === "Target.detachFromTarget") detach.arrive();
      return undefined;
    },
  });
  const provider = new CdpBrowserProvider();
  releaseFixture(provider, browser);
  const controller = new AbortController();
  const stallsDetach = hangOnMethod === "Target.detachFromTarget";
  if (stallsDetach)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const operation = provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 1_000,
    }),
    {
      signal: controller.signal,
      progress: {
        async report(update) {
          if (update.completed === 1) controller.abort();
        },
      },
    },
  );
  try {
    if (stallsDetach) {
      await detach.reached(operation, "stalled target detach");
      expect(browser.activeConnectionCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(await operation).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "observe_web_session",
      },
    });
  } finally {
    if (stallsDetach) vi.useRealTimers();
  }
  expect(browser.commands.map(({ method }) => method)).not.toContain(
    "Page.disable",
  );
  await expectReleasedSession(browser);
});

it("releases cleanup when cancellation arrives after capture completes", async () => {
  const disabling = phaseArrival();
  const browser = await startFakeCdpBrowser({
    hangOnMethod: "Page.disable",
    commandError({ method }) {
      if (method === "Page.disable") disabling.arrive();
      return undefined;
    },
  });
  const provider = new CdpBrowserProvider();
  releaseFixture(provider, browser);
  const controller = new AbortController();
  const pending = provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 1,
    }),
    { signal: controller.signal },
  );
  await disabling.reached(pending, "optional page shutdown");
  controller.abort();
  const result = await pending;
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      operation: "observe_web_session",
    },
  });
  await expectReleasedSession(browser);
  expect((await fetch(`${browser.endpoint}/json/version`)).ok).toBe(true);
});

it("retains the page inspection when bundle cleanup is cancelled", async () => {
  const controller = new AbortController();
  const browser = await startFakeCdpBrowser({
    commandError(command) {
      if (command.method !== "Target.detachFromTarget") return undefined;
      controller.abort();
      return undefined;
    },
  });
  const provider = new CdpBrowserProvider();
  releaseFixture(provider, browser);

  const result = await provider.analyzeBundle(
    analyzeWebBundleInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      fetch_source_maps: false,
      observation_ms: 0,
    }),
    { signal: controller.signal },
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      operation: "analyze_web_bundle",
      partialObservation: {
        target: { target_id: "allowed-page" },
        capture_window: expect.any(Object),
      },
    },
  });
  await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
});

it("skips optional Electron shutdown after cancellation at the structural read", async () => {
  const root = await createTestTempDirectory("rea-electron-cancel-");
  const page = join(root, "index.html");
  await writeFile(page, "<main>fixture</main>");
  const browser = await startFakeCdpBrowser({
    electronFileUrl: pathToFileURL(page).href,
    hangOnMethod: "Page.disable",
  });
  const provider = new CdpElectronProvider();
  releaseFixture(provider, browser);
  const controller = new AbortController();
  const result = await provider.inspectPage(
    inspectElectronPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "electron-page",
      observation_ms: 0,
    }),
    {
      signal: controller.signal,
      progress: {
        report(update) {
          if (update.completed === 2) controller.abort();
          return Promise.resolve();
        },
      },
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      operation: "inspect_electron_page",
    },
  });
  const methods = browser.commands.map(({ method }) => method);
  expect(methods).not.toContain("Page.disable");
  await expectReleasedSession(browser);
  expect((await fetch(`${browser.endpoint}/json/version`)).ok).toBe(true);
});

it("classifies cancellation that arrives during final Electron detach", async () => {
  const root = await createTestTempDirectory("rea-electron-final-detach-");
  const page = join(root, "index.html");
  await writeFile(page, "<main>completed fixture</main>");
  const controller = new AbortController();
  const browser = await startFakeCdpBrowser({
    electronFileUrl: pathToFileURL(page).href,
    commandError(command) {
      if (command.method !== "Target.detachFromTarget") return undefined;
      // This command is issued only after page inspection has completed.
      controller.abort();
      return { code: -32_000, message: "controlled detach rejection" };
    },
  });
  const provider = new CdpElectronProvider();
  releaseFixture(provider, browser);

  const result = await provider.inspectPage(
    inspectElectronPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "electron-page",
      observation_ms: 0,
    }),
    { signal: controller.signal },
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      operation: "inspect_electron_page",
      partialObservation: {
        kind: "electron-page-observation",
        cleanup: "transport-closed",
        inspection: {
          target: { target_id: "electron-page", file_path: page },
          dom: { total_nodes: expect.any(Number) },
        },
      },
    },
  });
  const methods = browser.commands.map(({ method }) => method);
  expect(methods).toContain("Page.getFrameTree");
  await expectReleasedSession(browser);
  expect((await fetch(`${browser.endpoint}/json/version`)).ok).toBe(true);
});

it.each(
  (["browser", "electron"] as const).flatMap((kind) =>
    (["completed", "failed", "attach-failed"] as const).map((outcome) => ({
      kind,
      outcome,
    })),
  ),
)(
  "resolves $kind $outcome inspection and cleanup composition after confirmed socket retry",
  async ({ kind, outcome }) => {
    const root = await createTestTempDirectory("rea-cdp-cleanup-binding-");
    const page = join(root, "index.html");
    await writeFile(page, "<main>completed fixture</main>");
    const browser = await startFakeCdpBrowser({
      ...(kind === "electron"
        ? { electronFileUrl: pathToFileURL(page).href }
        : {}),
      commandError(command) {
        return (outcome === "failed" &&
          command.method === "Page.getFrameTree") ||
          (outcome === "attach-failed" &&
            command.method === "Target.attachToTarget")
          ? { code: -32_000, message: "controlled primary frame read failure" }
          : undefined;
      },
    });
    const provider =
      kind === "browser" ? new CdpBrowserProvider() : new CdpElectronProvider();
    const controller = new AbortController();
    const reason = new Error("cancel during failed transport close");
    const originalClose = CdpConnection.prototype.close;
    let denied = true;
    const closing = vi
      .spyOn(CdpConnection.prototype, "close")
      .mockImplementation(function (this: CdpConnection) {
        if (!denied) return originalClose.call(this);
        controller.abort(reason);
        return Promise.reject(new Error("controlled transport close failure"));
      });
    onTestFinished(async () => {
      closing.mockRestore();
      await provider.close();
      await browser.close();
    });
    const result =
      provider instanceof CdpBrowserProvider
        ? await provider.inspectPage(
            inspectWebPageInputSchema.parse({
              cdp_endpoint: browser.endpoint,
              target_id: "allowed-page",
              allowed_origins: [browser.allowedOrigin],
              observation_ms: 0,
            }),
            { signal: controller.signal },
          )
        : await provider.inspectPage(
            inspectElectronPageInputSchema.parse({
              cdp_endpoint: browser.endpoint,
              target_id: "electron-page",
              observation_ms: 0,
            }),
            { signal: controller.signal },
          );
    if (result.ok)
      throw new Error("Expected cancelled inspection with unresolved cleanup");
    expect(result.error.cleanupIncomplete).toBe(true);
    if (outcome === "completed")
      expect(result.error.partialObservation).toBeDefined();
    const observation = result.error.partialObservation;
    const aggregate = result.error.cause;
    if (!(aggregate instanceof AggregateError))
      throw new Error("Missing cancellation/cleanup aggregate");
    const primary = aggregate.errors[0];
    if (outcome === "completed") {
      expect(primary).toBeInstanceOf(AnalysisCancelledError);
      expect(primary.cause).toBe(reason);
    } else {
      expect(primary).toBeInstanceOf(CdpCommandRejection);
      expect(primary.reportedMessage).toBe(
        "controlled primary frame read failure",
      );
    }
    const primaryCause = primary.cause;
    const retry = await provider.close().catch((cause: unknown) => cause);
    if (!(retry instanceof AnalysisError))
      throw new Error("Missing typed retry failure");
    expect(retry.cleanupIncomplete).toBe(true);
    denied = false;
    await provider.close();
    await waitFor(() => expect(browser.activeConnectionCount()).toBe(0));
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(retry.cleanupIncomplete).toBe(false);
    expect(result.error.partialObservation).toBe(observation);
    expect(primary.cause).toBe(primaryCause);
  },
);
