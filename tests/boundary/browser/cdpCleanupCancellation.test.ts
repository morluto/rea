import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it, onTestFinished, vi } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { inspectElectronPageInputSchema } from "../../../src/domain/javascript/electronObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

it.each(["Page.disable", "Target.detachFromTarget"])(
  "finishes caller cancellation even when %s has no response",
  async (hangOnMethod) => {
    const browser = await startFakeCdpBrowser({ hangOnMethod });
    onTestFinished(async () => {
      await browser.close();
    });
    const controller = new AbortController();
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1_000,
      }),
      {
        signal: controller.signal,
        progress: {
          report(update) {
            if (update.completed === 1) controller.abort();
            return Promise.resolve();
          },
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "observe_web_session",
      },
    });
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).toContain("Target.detachFromTarget");
    expect(methods).not.toContain("Target.closeTarget");
    expect(methods).not.toContain("Browser.close");
  },
);

it("releases cleanup when cancellation arrives after capture completes", async () => {
  const browser = await startFakeCdpBrowser({ hangOnMethod: "Page.disable" });
  onTestFinished(async () => {
    await browser.close();
  });
  const controller = new AbortController();
  const pending = new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 1,
    }),
    { signal: controller.signal },
  );
  await vi.waitFor(() => {
    expect(
      browser.commands.some(({ method }) => method === "Page.disable"),
    ).toBe(true);
  });
  controller.abort();
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(browser.commands.map(({ method }) => method)).toContain(
    "Target.detachFromTarget",
  );
});

it("closes an Electron inspection session when cleanup is cancelled", async () => {
  const root = await createTestTempDirectory("rea-electron-cancel-");
  const page = join(root, "index.html");
  await writeFile(page, "<main>fixture</main>");
  const browser = await startFakeCdpBrowser({
    electronFileUrl: pathToFileURL(page).href,
    hangOnMethod: "Page.disable",
  });
  onTestFinished(async () => {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const pending = new CdpElectronProvider().inspectPage(
    inspectElectronPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "electron-page",
      observation_ms: 1_000,
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
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolveTimeout) => {
    timeoutId = setTimeout(() => resolveTimeout(null), 2_000);
  });
  const result = await Promise.race([pending, timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  expect(result).not.toBeNull();
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      operation: "inspect_electron_page",
    },
  });
  expect(browser.commands.map(({ method }) => method)).toContain(
    "Page.disable",
  );
  const methods = browser.commands.map(({ method }) => method);
  expect(methods).toContain("Target.detachFromTarget");
  expect(methods).not.toContain("Target.closeTarget");
  expect(methods).not.toContain("Browser.close");
});
