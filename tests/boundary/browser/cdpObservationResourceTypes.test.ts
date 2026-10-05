import { expect, it, onTestFinished } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

it.each(["Fetch", "Script"] as const)(
  "does not treat a %s redirect as leaving the observed page",
  async (type) => {
    const browser = await startFakeCdpBrowser({
      sessionTimeline: "outside_policy",
      sessionRedirectResourceType: type,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("window_elapsed");
    expect(result.value.timeline.some(({ type }) => type === "redirect")).toBe(
      false,
    );
  },
);

it.each(["Document", undefined] as const)(
  "retains outside-origin scope rejection for %s redirect metadata",
  async (type) => {
    const browser = await startFakeCdpBrowser({
      sessionTimeline: "outside_policy",
      ...(type === undefined ? {} : { sessionRedirectResourceType: type }),
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 1,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("target_left_scope");
    expect(result.value.timeline.some(({ type }) => type === "redirect")).toBe(
      true,
    );
  },
);
