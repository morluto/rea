import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { frameNavigated, trackBrowser } from "./cdpBrowserProvider.support.js";

const observeDuringPreparation = async (
  commandEvents: NonNullable<FakeOptions["commandEvents"]>,
) => {
  return observeWithFake({
    eventsBeforeReply: ["Network.enable", "Performance.getMetrics"],
    commandResult: (command) =>
      command.method === "Performance.getMetrics"
        ? { metrics: [{ name: "Timestamp", value: 20 }] }
        : undefined,
    commandEvents,
  });
};

const observeWithFake = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
  trackBrowser(browser);
  const progress: number[] = [];
  const result = await new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 20,
    }),
    {
      progress: {
        report: async (update) => {
          progress.push(update.completed);
        },
      },
    },
  );
  if (!result.ok) throw result.error;
  return { browser, progress, observation: result.value };
};

const laterInWindowRequest = (
  command: Parameters<NonNullable<FakeOptions["commandEvents"]>>[0],
  origin: string,
) => ({
  method: "Network.requestWillBeSent",
  sessionId: command.sessionId,
  params: {
    requestId: "later-in-window-request",
    timestamp: 21,
    type: "Document",
    frameId: "frame-main",
    redirectResponse: { url: `${origin}/prior` },
    request: { url: `${origin}/later` },
  },
});

const foreignUrl = "https://outside.invalid/path";
type WireCommand = Parameters<NonNullable<FakeOptions["commandEvents"]>>[0];
const outsideNavigation = {
  navigation_committed: (command: WireCommand) =>
    frameNavigated(command, {
      id: "frame-main",
      loaderId: "outside-loader",
      url: foreignUrl,
    }),
  navigation_requested: (command: WireCommand) => ({
    method: "Page.frameRequestedNavigation",
    sessionId: command.sessionId,
    params: {
      frameId: "frame-main",
      url: foreignUrl,
      reason: "scriptInitiated",
    },
  }),
  redirect: (command: WireCommand, origin: string) => ({
    method: "Network.requestWillBeSent",
    sessionId: command.sessionId,
    params: {
      requestId: "outside-redirect",
      type: "Document",
      frameId: "frame-main",
      redirectResponse: { url: `${origin}/prior`, status: 302 },
      request: { url: foreignUrl },
    },
  }),
};

it.each([
  ["Network.enable", "navigation_committed", { loader_id: "outside-loader" }],
  [
    "Performance.getMetrics",
    "navigation_committed",
    { loader_id: "outside-loader" },
  ],
  ["Performance.getMetrics", "navigation_requested", {}],
  ["Performance.getMetrics", "redirect", { request_id: "outside-redirect" }],
] as const)(
  "ends preparation for a foreign %s event of type %s",
  async (phase, type, identity) => {
    const { browser, observation, progress } = await observeDuringPreparation(
      (command, origin) => {
        const later =
          command.method === "Performance.getMetrics"
            ? [laterInWindowRequest(command, origin)]
            : [];
        if (command.method === phase)
          return [outsideNavigation[type](command, origin), ...later];
        return later.length === 0 ? undefined : later;
      },
    );

    expect(observation.window.end_reason).toBe("target_left_scope");
    expect(progress).toEqual([2]);
    expect(observation.target.final_url).toBeNull();
    expect(observation.timeline).toContainEqual(
      expect.objectContaining({
        ...identity,
        type,
        timestamp: null,
        destination_scope: "outside_policy",
        url: null,
        ...(type === "redirect"
          ? {
              redirect_response: {
                scope: "approved",
                status: 302,
                url: `${browser.allowedOrigin}/prior`,
              },
            }
          : {}),
      }),
    );
    expect(observation.timeline).not.toContainEqual(
      expect.objectContaining({ request_id: "later-in-window-request" }),
    );
  },
);

it("accounts for each malformed frame commit without inventing a main-frame navigation", async () => {
  const { observation } = await observeDuringPreparation((command) =>
    command.method === "Performance.getMetrics"
      ? [
          frameNavigated(command, { url: "https://outside.invalid/unknown" }),
          frameNavigated(command, {
            id: 3,
            parentId: "frame-main",
            url: "https://outside.invalid/child",
          }),
        ]
      : undefined,
  );

  expect(observation.window.end_reason).toBe("window_elapsed");
  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ type: "navigation_committed" }),
  );
  expect(observation.completeness.unavailable_sections).toContain("timeline");
  expect(observation.completeness.excluded).toContainEqual(
    expect.objectContaining({
      section: "timeline",
      reason: "invalid_protocol_value",
      count: 2,
    }),
  );
});

it("updates the main frame from a pre-arm root replacement without inventing a navigation row", async () => {
  const { observation } = await observeDuringPreparation((command, origin) =>
    command.method === "Performance.getMetrics"
      ? [
          frameNavigated(command, {
            id: "replacement-main",
            loaderId: "replacement-loader",
            url: `${origin}/app?token=frame-secret`,
          }),
          {
            method: "Page.lifecycleEvent",
            sessionId: command.sessionId,
            params: {
              frameId: "replacement-main",
              loaderId: "replacement-loader",
              name: "DOMContentLoaded",
              timestamp: 21,
            },
          },
          // The replaced root no longer scopes main-frame lifecycle rows.
          {
            method: "Page.lifecycleEvent",
            sessionId: command.sessionId,
            params: {
              frameId: "frame-main",
              loaderId: "loader-frame-main",
              name: "load",
              timestamp: 22,
            },
          },
        ]
      : undefined,
  );

  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ type: "lifecycle", frame_id: "frame-main" }),
  );

  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ type: "navigation_committed" }),
  );
  expect(observation.timeline).toContainEqual(
    expect.objectContaining({
      type: "lifecycle",
      frame_id: "replacement-main",
      loader_id: "replacement-loader",
      timestamp: 21,
      detail: "domcontentloaded",
    }),
  );
  expect(observation.limitations).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /Buffered events.*unknown timing.*context only.*do not establish.*observation window/iu,
      ),
    ]),
  );
});

it.each([
  [
    "Inspector.targetCrashed",
    "target_terminated",
    "target_terminated",
    {
      method: "Inspector.targetCrashed",
      sessionId: "session-1",
      params: {},
    },
  ],
  [
    "Target.detachedFromTarget",
    "session_detached",
    "session_detached",
    {
      method: "Target.detachedFromTarget",
      params: { sessionId: "session-1", targetId: "allowed-page" },
    },
  ],
] as const)(
  "ends on buffered untimestamped %s before collecting later events",
  async (_method, endReason, eventType, terminalEvent) => {
    const { observation, browser } = await observeWithFake({
      eventsBeforeReply: ["Performance.getMetrics"],
      commandResult: (command) =>
        command.method === "Performance.getMetrics"
          ? { metrics: [{ name: "Timestamp", value: 20 }] }
          : undefined,
      commandEvents: (command, origin) => {
        if (command.method !== "Performance.getMetrics") return undefined;
        return [
          terminalEvent,
          {
            method: "Network.requestWillBeSent",
            sessionId: command.sessionId,
            params: {
              requestId: "after-terminal-event",
              timestamp: 21,
              type: "Document",
              frameId: "frame-main",
              redirectResponse: { url: `${origin}/prior` },
              request: { url: `${origin}/later` },
            },
          },
        ];
      },
    });

    expect(observation.window.end_reason).toBe(endReason);
    expect(
      browser.commands.some(
        ({ method }) => method === "Page.setLifecycleEventsEnabled",
      ),
    ).toBe(false);
    expect(observation.timeline).toContainEqual(
      expect.objectContaining({
        type: eventType,
        timestamp: null,
      }),
    );
    expect(observation.timeline).not.toContainEqual(
      expect.objectContaining({ request_id: "after-terminal-event" }),
    );
    expect(observation.limitations).toContainEqual(
      expect.stringMatching(
        /Buffered events.*unknown timing.*context only.*do not establish.*observation window/iu,
      ),
    );
  },
);

it("represents absent timeline timestamps as unknown and preserves an observed zero", async () => {
  const { browser, observation } = await observeWithFake({
    eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
    commandEvents: (command, origin) => {
      if (command.method !== "Page.setLifecycleEventsEnabled") return undefined;
      return [
        {
          method: "Page.navigatedWithinDocument",
          sessionId: command.sessionId,
          params: {
            frameId: "frame-main",
            url: `${origin}/without-clock-value`,
            navigationType: "historyApi",
          },
        },
        {
          method: "Network.requestWillBeSent",
          sessionId: command.sessionId,
          params: {
            requestId: "actual-zero-clock-value",
            type: "Document",
            frameId: "frame-main",
            timestamp: 0,
            request: { url: `${origin}/document`, method: "GET" },
          },
        },
        {
          method: "Network.loadingFailed",
          sessionId: command.sessionId,
          params: {
            requestId: "actual-zero-clock-value",
            type: "Document",
            errorText: "net::ERR_CONNECTION_REFUSED",
            timestamp: 0,
          },
        },
      ];
    },
  });

  expect(observation.timeline).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "same_document_navigation",
        url: `${browser.allowedOrigin}/without-clock-value`,
        timestamp: null,
      }),
      expect.objectContaining({
        type: "load_failed",
        request_id: "actual-zero-clock-value",
        timestamp: 0,
      }),
    ]),
  );
});

it("ends an armed observation at a fatal protocol failure without waiting out its window", async () => {
  const browser = await startFakeCdpBrowser({
    malformedEventOnMethod: "Page.setLifecycleEventsEnabled",
  });
  trackBrowser(browser);
  // The window outlasts every test deadline, so returning at all shows the
  // fatal failure ended it; waiting it out turns into a deadline failure.
  const result = await new CdpBrowserProvider().observeSession(
    observeWebSessionInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 600_000,
    }),
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "BrowserObservationError", reason: "protocol_error" },
  });
});

it("does not join an empty document request identity to a later loading failure", async () => {
  const { observation } = await observeDuringPreparation((command, origin) => {
    if (command.method !== "Performance.getMetrics") return undefined;
    return [
      {
        ...laterInWindowRequest(command, origin),
        params: {
          ...laterInWindowRequest(command, origin).params,
          requestId: "",
        },
      },
      {
        method: "Network.loadingFailed",
        sessionId: command.sessionId,
        params: {
          requestId: "",
          timestamp: 22,
          errorText: "net::ERR_FAILED",
        },
      },
    ];
  });
  expect(observation.window.end_reason).toBe("window_elapsed");
  expect(observation.timeline).toContainEqual(
    expect.objectContaining({ type: "redirect", request_id: null }),
  );
  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ type: "load_failed" }),
  );
  expect(observation.timeline).not.toContainEqual(
    expect.objectContaining({ request_id: "" }),
  );
  expect(observation.completeness.excluded).toContainEqual(
    expect.objectContaining({
      section: "timeline",
      reason: "invalid_protocol_value",
    }),
  );
});

const redirectCases = [
  ...(
    [
      ["string status", "302"],
      ["null status", null],
      ["boolean status", false],
      ["object status", {}],
      ["zero status", 0],
    ] as const
  ).map(([name, status]) => ({
    name,
    response: (origin: string) => ({ url: `${origin}/prior`, status }),
    expected: (origin: string) => ({
      url: `${origin}/prior`,
      status: null,
      scope: "approved",
    }),
  })),
  {
    name: "malformed URL",
    response: (_origin: string) => ({ url: "http://%", status: 302 }),
    expected: (_origin: string) => ({ url: null, status: null, scope: null }),
  },
  {
    name: "empty URL",
    response: (_origin: string) => ({ url: "", status: 302 }),
    expected: (_origin: string) => ({ url: null, status: null, scope: null }),
  },

  {
    name: "missing URL",
    response: (_origin: string) => ({ status: 302 }),
    expected: (_origin: string) => ({ url: null, status: null, scope: null }),
  },
  {
    name: "missing status",
    response: (origin: string) => ({ url: `${origin}/prior` }),
    expected: (origin: string) => ({
      url: `${origin}/prior`,
      status: null,
      scope: "approved",
    }),
  },
  {
    name: "outside origin",
    response: (_origin: string) => ({
      url: "https://outside.invalid/previous",
      status: 302,
    }),
    expected: (_origin: string) => ({
      url: null,
      status: null,
      scope: "outside_policy",
    }),
  },
  {
    name: "unsupported URL",
    response: (_origin: string) => ({
      url: "data:text/html,discard-redirect-body",
      status: 302,
    }),
    expected: (_origin: string) => ({
      url: null,
      status: null,
      scope: "unsupported",
    }),
  },
  {
    name: "credentials",
    response: (origin: string) => ({
      url:
        origin.replace("http://", "http://user:discard-redirect-secret@") +
        "/prior?token=visible",
      status: 302,
    }),
    expected: (origin: string) => ({
      url: `${origin}/prior?token=visible`,
      status: 302,
      scope: "approved",
    }),
  },
];

it("retains scoped redirect response facts for each request", async () => {
  const { browser, observation } = await observeDuringPreparation(
    (command, origin) => {
      if (command.method !== "Performance.getMetrics") return undefined;
      return redirectCases.map(({ name, response }, index) => ({
        method: "Network.requestWillBeSent",
        sessionId: command.sessionId,
        params: {
          requestId: name,
          timestamp: 21 + index,
          type: "Document",
          frameId: "frame-main",
          request: { url: `${origin}/next`, method: "GET" },
          redirectResponse: {
            ...response(origin),
            headers: { Authorization: "discard-redirect-header" },
          },
        },
      }));
    },
  );

  expect(observation.window.end_reason).toBe("window_elapsed");
  expect(
    observation.timeline
      .filter(({ type }) => type === "redirect")
      .map(({ request_id, redirect_response }) => ({
        request_id,
        redirect_response,
      })),
  ).toEqual(
    redirectCases.map(({ name, expected }) => ({
      request_id: name,
      redirect_response: expected(browser.allowedOrigin),
    })),
  );

  const timelineExclusions = observation.completeness.excluded.filter(
    ({ section }) => section === "timeline",
  );
  expect(timelineExclusions).toHaveLength(3);
  expect(timelineExclusions).toEqual(
    expect.arrayContaining([
      { section: "timeline", reason: "invalid_protocol_value", count: 8 },
      { section: "timeline", reason: "disallowed_origin", count: 1 },
      { section: "timeline", reason: "unsupported_url", count: 1 },
    ]),
  );
  expect(observation.completeness.policy_filtered_sections).toContain(
    "timeline",
  );
  const serialized = JSON.stringify(observation);
  expect(serialized).not.toContain("discard-redirect-");
  expect(serialized).not.toContain("outside.invalid");
});
