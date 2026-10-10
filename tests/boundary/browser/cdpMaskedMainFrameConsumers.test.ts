import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const limitation =
  "Chromium masked the main-frame URL in Page.getFrameTree; REA authorized and attributed the root frame using Target.getTargetInfo for the same attached target.";

describe("masked Chromium main-frame consumers", () => {
  it("captures a screenshot against the verified target URL", async () => {
    const browser = await startFakeCdpBrowser({ attachedFrameUrl: ":" });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.target).toMatchObject({
      target_id: "allowed-page",
      url: `${browser.allowedOrigin}/app?token=page-secret#fragment`,
      origin: browser.allowedOrigin,
    });
    expect(result.value.limitations).toContain(limitation);
    expect(browser.commands.map(({ method }) => method)).toContain(
      "Page.captureScreenshot",
    );
  });

  it("finishes session observation against the verified target URL", async () => {
    const browser = await startFakeCdpBrowser({ attachedFrameUrl: ":" });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.target).toEqual({
      target_id: "allowed-page",
      initial_url: `${browser.allowedOrigin}/app?token=page-secret#fragment`,
      final_url: `${browser.allowedOrigin}/app?token=page-secret#fragment`,
    });
    expect(result.value.window.end_reason).toBe("window_elapsed");
    expect(result.value.limitations).toContain(limitation);
  });
});
