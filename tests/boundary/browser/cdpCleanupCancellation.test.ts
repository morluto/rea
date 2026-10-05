import { expect, it, onTestFinished, vi } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
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
