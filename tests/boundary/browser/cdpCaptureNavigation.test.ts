import { expect, it, onTestFinished } from "vitest";

import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

it("captures a page without aborting on a duplicate frame event", async () => {
  const browser = await startFakeCdpBrowser({ sessionTimeline: "same_origin" });
  onTestFinished(async () => {
    await browser.close();
  });
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  expect(result.ok).toBe(true);
});
