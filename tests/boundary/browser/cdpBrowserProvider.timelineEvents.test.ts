import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { frameNavigated, trackBrowser } from "./cdpBrowserProvider.support.js";

it("keeps a long observation pending until the caller cancels it", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const controller = new AbortController();
  const reason = { stop: "long observation" };
  let stop: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await provider.observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 3_000_000_000,
      }),
      {
        signal: controller.signal,
        progress: {
          async report(update) {
            if (
              update.phase === "browser_observation" &&
              update.completed === 1
            )
              stop = setTimeout(() => controller.abort(reason), 150);
          },
        },
      },
    );

    if (result.ok) throw new Error("Long window completed before cancellation");
    expect(result.error).toMatchObject({ _tag: "AnalysisCancelledError" });
    expect(result.error.cause).toBe(reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  } finally {
    clearTimeout(stop);
    await provider.close();
  }
});

it("does not retain a caller listener when the target ends before the wait starts", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: ({ method, sessionId }) =>
      method === "Page.setLifecycleEventsEnabled"
        ? [
            {
              method: "Page.frameNavigated",
              ...(sessionId === undefined ? {} : { sessionId }),
              params: {
                frame: { id: "frame-main", url: "https://outside.test/" },
              },
            },
          ]
        : undefined,
  });
  trackBrowser(browser);
  const controller = new AbortController();
  const provider = new CdpBrowserProvider();
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 3_000_000_000,
    }),
    { signal: controller.signal },
  );
  if (!result.ok) throw result.error;
  expect(result.value.window).toMatchObject({
    requested_ms: 3_000_000_000,
    end_reason: "target_left_scope",
  });
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  await provider.close();
});

it("preserves cancellation during the armed handshake", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const controller = new AbortController();
  const reason = { stop: "at armed handshake" };
  const provider = new CdpBrowserProvider();
  const result = await provider.observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 3_000_000_000,
    }),
    {
      signal: controller.signal,
      progress: {
        async report(update) {
          if (update.phase === "browser_observation" && update.completed === 1)
            controller.abort(reason);
        },
      },
    },
  );
  if (result.ok) throw new Error("Expected armed cancellation");
  expect(result.error.cause).toBe(reason);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
  await provider.close();
});

it("retains incomplete navigation facts without rejecting the target scope", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        frameNavigated(command, {
          id: "frame-main",
          loaderId: "numeric-fragment",
          url: `${origin}/first`,
          urlFragment: 7,
        }),
        frameNavigated(command, {
          id: "frame-main",
          loaderId: "unprefixed-fragment",
          url: `${origin}/second`,
          urlFragment: "bad-fragment",
        }),
        {
          method: "Page.navigatedWithinDocument",
          sessionId: command.sessionId,
          params: { frameId: "frame-main" },
        },
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            frameId: "frame-main",
            requestId: "missing-destination",
            type: "Document",
            redirectResponse: { url: `${origin}/prior`, status: 302 },
            request: {},
          },
        },
      ];
    },
  });
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
  expect(result.value.window.end_reason).toBe("window_elapsed");
  expect(result.value.timeline).toEqual([
    expect.objectContaining({
      type: "navigation_committed",
      loader_id: "numeric-fragment",
      url: null,
      destination_scope: "approved",
    }),
    expect.objectContaining({
      type: "navigation_committed",
      loader_id: "unprefixed-fragment",
      url: null,
      destination_scope: "approved",
    }),
    expect.objectContaining({
      type: "same_document_navigation",
      url: null,
    }),
    expect.objectContaining({
      type: "redirect",
      request_id: "missing-destination",
      url: null,
      redirect_response: {
        url: `${browser.allowedOrigin}/prior`,
        scope: "approved",
        status: 302,
      },
    }),
  ]);
  expect(result.value.completeness.excluded).toContainEqual({
    section: "timeline",
    reason: "invalid_protocol_value",
    count: 4,
  });
  expect(result.value.completeness.policy_filtered_sections).toEqual([]);
});

it("ends the window when a malformed commit still identifies a foreign origin", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command) =>
      command.method === "Page.setLifecycleEventsEnabled"
        ? [
            frameNavigated(command, {
              id: "frame-main",
              url: "https://foreign.test/",
              urlFragment: "bad-fragment",
            }),
          ]
        : undefined,
  });
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
  expect(result.value.window.end_reason).toBe("target_left_scope");
  expect(result.value.target.final_url).toBeNull();
  expect(result.value.timeline).toEqual([
    expect.objectContaining({
      type: "navigation_committed",
      url: null,
      destination_scope: "outside_policy",
    }),
  ]);
  expect(result.value.completeness.excluded).toEqual(
    expect.arrayContaining([
      { section: "timeline", reason: "invalid_protocol_value", count: 1 },
      { section: "timeline", reason: "out_of_target_scope", count: 1 },
    ]),
  );
});

it.each([
  {
    name: "approved URL",
    frame: (origin: string) => ({
      url: `${origin}/final?token=visible`,
      urlFragment: "#location",
    }),
    finalUrl: (origin: string) => `${origin}/final?token=visible#location`,
    endReason: "window_elapsed",
    exclusions: [],
  },
  {
    name: "approved origin with an invalid fragment",
    frame: (origin: string) => ({ url: `${origin}/final`, urlFragment: 7 }),
    finalUrl: () => null,
    endReason: "window_elapsed",
    exclusions: ["invalid_protocol_value"],
  },
  {
    name: "foreign origin with an invalid fragment",
    frame: () => ({
      url: "https://foreign.test/final",
      urlFragment: "bad-fragment",
    }),
    finalUrl: () => null,
    endReason: "target_left_scope",
    exclusions: ["invalid_protocol_value", "out_of_target_scope"],
  },
  {
    name: "missing URL",
    frame: () => ({ urlFragment: "#location" }),
    finalUrl: () => null,
    endReason: "window_elapsed",
    exclusions: ["invalid_protocol_value"],
  },
])(
  "uses the final frame-tree evidence for $name",
  async ({ frame, finalUrl, endReason, exclusions }) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }, origin, reads) =>
        method === "Page.getFrameTree" && reads > 1
          ? { frameTree: { frame: { id: "frame-main", ...frame(origin) } } }
          : undefined,
    });
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
    expect(result.value.target.final_url).toBe(finalUrl(browser.allowedOrigin));
    expect(result.value.window.end_reason).toBe(endReason);
    expect(
      result.value.completeness.excluded.filter(
        ({ section }) => section === "timeline",
      ),
    ).toEqual(
      exclusions.map((reason) => ({ section: "timeline", reason, count: 1 })),
    );
    expect(result.value.completeness.policy_filtered_sections).toEqual(
      endReason === "target_left_scope" ? ["timeline"] : [],
    );
  },
);

describe("CdpBrowserProvider navigation timeline", () => {
  it.each(["outside_policy", "target_detached"] as const)(
    "settles and releases a long wait after %s",
    async (sessionTimeline) => {
      const browser = await startFakeCdpBrowser({ sessionTimeline });
      trackBrowser(browser);
      const result = await new CdpBrowserProvider().observeSession(
        observeWebSessionInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          observation_ms: 3_000_000_000,
        }),
      );
      if (!result.ok) throw result.error;
      expect(result.value.window.end_reason).toBe(
        sessionTimeline === "outside_policy"
          ? "target_left_scope"
          : "session_detached",
      );
      if (sessionTimeline === "outside_policy") {
        expect(result.value.target.final_url).toBeNull();
        expect(result.value.timeline.at(-1)).toMatchObject({
          type: "redirect",
          request_id: "document-request",
          url: null,
          destination_scope: "outside_policy",
          redirect_response: {
            url: `${browser.allowedOrigin}/reloaded?token=session-secret`,
            status: 302,
            scope: "approved",
          },
        });
        expect(result.value.completeness).toMatchObject({
          status: "policy_filtered",
          policy_filtered_sections: ["timeline"],
          excluded: [
            { section: "timeline", reason: "out_of_target_scope", count: 1 },
          ],
        });
        expect(JSON.stringify(result.value)).not.toContain(
          "private.example.test",
        );
      } else {
        expect(result.value.timeline.at(-1)).toMatchObject({
          type: "session_detached",
          detail: "session_detached",
          timestamp: null,
        });
        expect(result.value.timeline).not.toContainEqual(
          expect.objectContaining({ type: "target_terminated" }),
        );
        expect(result.value.limitations).toContainEqual(
          expect.stringMatching(
            /Buffered events.*unknown timing.*context only.*do not establish.*observation window/iu,
          ),
        );
      }
      await expect.poll(() => browser.activeConnectionCount()).toBe(0);
    },
  );
  // Event count has no ceiling; only a dropped event truncates the timeline.
  it("returns every event of a long session timeline without truncating it", async () => {
    const timestamps = Array.from({ length: 2_001 }, (_, index) => index + 1);
    const browser = await startFakeCdpBrowser({
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
      eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
      commandEvents: (command) =>
        command.method === "Page.setLifecycleEventsEnabled"
          ? timestamps.map((timestamp) => ({
              method: "Page.lifecycleEvent",
              sessionId: command.sessionId,
              params: {
                frameId: "frame-main",
                name: "networkIdle",
                timestamp,
              },
            }))
          : undefined,
    });
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
    expect(
      result.value.timeline
        .filter(({ type }) => type === "lifecycle")
        .map(({ timestamp }) => timestamp),
    ).toEqual(timestamps);
    expect(result.value.completeness.truncated_sections).not.toContain(
      "timeline",
    );
  });
});
