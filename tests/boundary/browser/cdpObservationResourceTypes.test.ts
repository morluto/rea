import { expect, it, onTestFinished } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

it("ignores Fetch and Script redirects when observing page navigation", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) =>
      command.method === "Page.setLifecycleEventsEnabled"
        ? ["Fetch", "Script"].map((type) => ({
            method: "Network.requestWillBeSent",
            sessionId: command.sessionId,
            params: {
              requestId: type,
              frameId: "frame-main",
              type,
              request: { url: "https://private.example.test/redirected" },
              redirectResponse: { url: `${origin}/prior`, status: 302 },
            },
          }))
        : undefined,
  });
  onTestFinished(() => browser.close());
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
  expect(result.value.timeline).toEqual([]);
  expect(result.value.completeness.policy_filtered_sections).toEqual([]);
});

it("keeps final URL unknown when a redirect races the final frame-tree read", async () => {
  let frameTreeReads = 0;
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.getFrameTree"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.getFrameTree") return undefined;
      frameTreeReads += 1;
      if (frameTreeReads !== 2 || command.sessionId === undefined)
        return undefined;
      return [
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "late-main-document",
            type: "Document",
            frameId: "frame-main",
            request: {
              url: "https://private.example.test/redirected",
              method: "GET",
            },
            redirectResponse: { url: `${origin}/prior`, status: 302 },
          },
        },
      ];
    },
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
  expect(result.value.target.final_url).toBeNull();
  expect(result.value.timeline.at(-1)).toMatchObject({
    type: "redirect",
    request_id: "late-main-document",
    url: null,
    destination_scope: "outside_policy",
  });
  expect(JSON.stringify(result.value)).not.toContain("private.example.test");
});
