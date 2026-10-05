import { expect, it, onTestFinished } from "vitest";

import { CdpCaptureEvents } from "../../../src/browser/CdpCaptureEvents.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import type { CdpEvent } from "../../../src/browser/CdpConnection.js";

const events = (): CdpCaptureEvents =>
  new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: ["https://example.test"],
      target_id: "page-1",
    }),
    new Set(["https://example.test"]),
  );

const frameNavigated = (url: string, loaderId: string): CdpEvent => ({
  method: "Page.frameNavigated",
  params: {
    frame: { id: "main", url, loaderId },
  },
});

it("ignores a repeated frameNavigated for the document already committed", () => {
  const state = events();
  state.beginAuthorizedFrame("main");
  state.ingest(frameNavigated("https://example.test/page", "loader-1"));
  expect(state.navigationDuringCapture).toBe(true);
  state.navigationDuringCapture = false;

  // A re-fire with the same URL and loader is not a navigation.
  state.ingest(frameNavigated("https://example.test/page", "loader-1"));
  expect(state.navigationDuringCapture).toBe(false);
});

it("still reports a genuine change of document", () => {
  const state = events();
  state.beginAuthorizedFrame("main");
  state.ingest(frameNavigated("https://example.test/page", "loader-1"));
  state.navigationDuringCapture = false;
  state.ingest(frameNavigated("https://example.test/other", "loader-2"));
  expect(state.navigationDuringCapture).toBe(true);
});

it("does not forget a navigation that happened during the observation window", () => {
  const state = events();
  state.beginAuthorizedFrame("main");
  state.ingest(frameNavigated("https://example.test/page", "loader-1"));
  // The final capture re-attaches to the resolved frame; clearing the flag here
  // used to report a clean capture while carrying pre-navigation state.
  state.beginFinalCapture("main");
  expect(state.navigationDuringCapture).toBe(true);
});

it("keeps a settled observation window clean", () => {
  const state = events();
  state.beginAuthorizedFrame("main");
  state.beginFinalCapture("main");
  expect(state.navigationDuringCapture).toBe(false);
});

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
