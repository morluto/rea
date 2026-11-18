import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../../../src/domain/browserObservation.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { frameNavigated, trackBrowser } from "./cdpBrowserProvider.support.js";

const inspectWithNetworkEvents = async (
  commandEvents: NonNullable<FakeOptions["commandEvents"]>,
) => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Network.enable"],
    commandEvents,
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 1,
    }),
  );
  return { browser, result };
};

it("applies exact origin selection while retaining caller-visible URLs", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const cdp_endpoint = browser.endpoint;
  const allowed = {
    target_id: "allowed-page",
    origin: browser.allowedOrigin,
    url: `${browser.allowedOrigin}/app?token=page-secret#fragment`,
  };
  try {
    const unfiltered = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({ cdp_endpoint }),
    );
    if (!unfiltered.ok) throw unfiltered.error;
    expect(unfiltered.value.targets).toMatchObject([
      allowed,
      {
        target_id: "disallowed-page",
        origin: "https://private.example.test",
        url: "https://private.example.test/app?token=forbidden",
      },
    ]);
    expect(unfiltered.value.excluded).toEqual({
      disallowed_origin: 0,
      unsupported_url: 1,
      non_page: 1,
    });

    const filtered = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint,
        allowed_origins: [browser.allowedOrigin],
      }),
    );
    if (!filtered.ok) throw filtered.error;
    expect(filtered.value.targets).toMatchObject([allowed]);
    expect(filtered.value.excluded).toEqual({
      disallowed_origin: 1,
      unsupported_url: 1,
      non_page: 1,
    });
    expect(JSON.stringify(filtered.value)).not.toContain("forbidden");

    const inspected = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint,
        target_id: allowed.target_id,
        observation_ms: 0,
      }),
    );
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.target).toMatchObject({
      target_id: allowed.target_id,
      origin: allowed.origin,
      url: `${browser.allowedOrigin}/app?token=frame-secret`,
    });
  } finally {
    await provider.close();
  }
});

it.each([
  ["absolute", true, ""],
  ["host/path", "host-path", ""],
  ["root-relative", "root-relative", ""],
  ["prefixed host/path", "prefixed", "Loading "],
] as const)(
  "preserves URL-shaped %s target titles",
  async (_label, urlShapedAllowedTitle, prefix) => {
    const browser = await startFakeCdpBrowser({ urlShapedAllowedTitle });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const listInput = {
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
    };
    const input = {
      ...listInput,
      target_id: "allowed-page",
    };
    const authority = browser.allowedOrigin.replace(/^https?:\/\//u, "");
    const expected =
      _label === "absolute"
        ? `${browser.allowedOrigin}/app?startup=title-secret#fragment`
        : _label === "root-relative"
          ? "/app?startup=title-secret#fragment"
          : `${prefix}${authority}/app?startup=title-secret#fragment`;
    const listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse(listInput),
    );
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets[0]?.title).toBe(expected);

    const inspected = await provider.inspectPage(
      inspectWebPageInputSchema.parse({ ...input, observation_ms: 0 }),
    );
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.target.title).toBe(expected);
    expect(JSON.stringify({ listed, inspected })).toContain("title-secret");
  },
);

it("lists only usable direct transports and accounts for exclusions before capture", async () => {
  const browser = await startFakeCdpBrowser({
    pageScopedVersionWebSocket: true,
    omitTargetWebSocket: true,
    additionalPageWithWebSocket: true,
    additionalPageWithoutWebSocket: true,
  });
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const cdp_endpoint = browser.endpoint;
  const allowed_origins = [browser.allowedOrigin];
  const visibleIds = ["allowed-page", "allowed-page-with-socket"];
  const transportNotice =
    "otherwise allowed page target(s) lacked a validated direct CDP WebSocket";
  const requestedScope =
    "Only page targets with a validated CDP transport whose current URL matches an explicitly requested exact origin are listed.";
  try {
    for (const scenario of [
      {
        origins: [],
        ids: visibleIds,
        disallowed: 0,
        transportExclusions: ["2"],
        scope:
          "All page targets with supported HTTP(S) URLs and a validated CDP transport are listed.",
      },
      {
        origins: allowed_origins,
        ids: visibleIds,
        disallowed: 1,
        transportExclusions: ["1"],
        scope: requestedScope,
      },
      {
        origins: ["https://unlisted.example.test"],
        ids: [],
        disallowed: 4,
        transportExclusions: [],
        scope: requestedScope,
      },
    ]) {
      const listed = await provider.listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint,
          allowed_origins: scenario.origins,
        }),
      );
      if (!listed.ok) throw listed.error;
      expect(listed.value.targets.map(({ target_id }) => target_id)).toEqual(
        scenario.ids,
      );
      expect(listed.value.excluded).toEqual({
        disallowed_origin: scenario.disallowed,
        unsupported_url: 1,
        non_page: 1,
      });
      expect(listed.value.limitations).toContain(scenario.scope);
      expect(
        listed.value.limitations.filter((message) =>
          message.includes(transportNotice),
        ),
      ).toEqual(
        scenario.transportExclusions.map(
          (count) => `${count} ${transportNotice} and were excluded.`,
        ),
      );
    }
    expect(browser.commands).toEqual([]);
    expect(browser.openedConnectionCount()).toBe(0);

    for (const target_id of visibleIds) {
      const inspected = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint,
          allowed_origins,
          target_id,
          observation_ms: 0,
        }),
      );
      if (!inspected.ok) throw inspected.error;
      expect(inspected.value.target.target_id).toBe(target_id);
      if (target_id === "allowed-page")
        expect(inspected.value.network.requests).toHaveLength(1);
    }
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).not.toContain("Target.attachToTarget");
    expect(methods).not.toContain("Target.detachFromTarget");
    expect(
      browser.commands.every(({ sessionId }) => sessionId === undefined),
    ).toBe(true);
  } finally {
    await provider.close();
  }
});

it("fails with a protocol error after an unidentifiable frame event and detaches", async () => {
  const { browser, result } = await inspectWithNetworkEvents((command) =>
    command.method === "Network.enable"
      ? [
          {
            method: "Page.frameNavigated",
            ...(command.sessionId === undefined
              ? {}
              : { sessionId: command.sessionId }),
            params: undefined,
          },
        ]
      : undefined,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "BrowserObservationError", reason: "protocol_error" },
  });
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
});

it("retains malformed child-frame identity as frame coverage while completing capture", async () => {
  const { browser, result } = await inspectWithNetworkEvents((command) =>
    command.method === "Network.enable"
      ? [
          frameNavigated(command, {
            id: 3,
            parentId: "frame-main",
            url: "https://outside.invalid/child",
          }),
        ]
      : undefined,
  );
  if (!result.ok) throw result.error;
  expect(result.value.completeness.unavailable_sections).toContain("frames");
  expect(result.value.target.url).toBe(
    `${browser.allowedOrigin}/app?token=frame-secret`,
  );
});

it("fails capture on a contradictory self-parented frame instead of accepting it as a child", async () => {
  const { browser, result } = await inspectWithNetworkEvents(
    (command, origin) =>
      command.method === "Network.enable"
        ? [
            frameNavigated(command, {
              id: "candidate-root",
              parentId: "candidate-root",
              url: `${origin}/app?token=frame-secret`,
            }),
          ]
        : undefined,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { reason: "protocol_error" },
  });
  await expect.poll(() => browser.activeConnectionCount()).toBe(0);
});

it("treats a same-URL and same-loader root frame ID change as a capture change", async () => {
  const { result } = await inspectWithNetworkEvents((command, origin) =>
    command.method === "Network.enable"
      ? [
          frameNavigated(command, {
            id: "replacement-main",
            loaderId: "loader-main",
            url: `${origin}/app?token=frame-secret`,
          }),
        ]
      : undefined,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "BrowserObservationError", reason: "target_changed" },
  });
});

describe("CdpBrowserProvider: discovery authorization 2", () => {
  it("rejects empty browser attachment session identifiers", async () => {
    const browser = await startFakeCdpBrowser({ invalidAttachedSession: true });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "protocol_error" },
    });
    expect(browser.commands.map(({ method }) => method)).toEqual([
      "Target.attachToTarget",
    ]);
  });

  it("returns typed errors for malformed discovery and disconnects", async () => {
    const malformed = await startFakeCdpBrowser({ malformedDiscovery: true });
    trackBrowser(malformed);
    const malformedResult = await new CdpBrowserProvider().listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: malformed.endpoint,
        allowed_origins: [malformed.allowedOrigin],
      }),
    );
    expect(malformedResult).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        reason: "invalid_endpoint_response",
      },
    });

    const disconnecting = await startFakeCdpBrowser({
      closeOnMethod: "Page.getFrameTree",
    });
    trackBrowser(disconnecting);
    const disconnectedResult = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: disconnecting.endpoint,
        allowed_origins: [disconnecting.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    expect(disconnectedResult).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "disconnected" },
    });
  });
});

describe("CdpBrowserProvider: target selection detail", () => {
  it("keeps target selection detail for every target operation", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const operations = [
      [
        "inspect_web_page",
        (input) =>
          provider.inspectPage(
            inspectWebPageInputSchema.parse({ ...input, observation_ms: 0 }),
          ),
      ],
      [
        "analyze_web_bundle",
        (input) =>
          provider.analyzeBundle(
            analyzeWebBundleInputSchema.parse({ ...input, observation_ms: 0 }),
          ),
      ],
      [
        "observe_web_session",
        (input) =>
          provider.observeSession(observeWebSessionInputSchema.parse(input)),
      ],
      [
        "discover_webmcp_tools",
        (input) =>
          provider.discoverWebMcpTools(
            discoverWebMcpToolsInputSchema.parse(input),
          ),
      ],
      [
        "capture_web_screenshot",
        (input) =>
          provider.captureScreenshot(
            captureWebScreenshotInputSchema.parse(input),
          ),
      ],
    ] as const satisfies readonly (readonly [
      string,
      (input: Record<string, unknown>) => Promise<{ readonly ok: boolean }>,
    ])[];
    const selections = [
      [
        "missing",
        "target_not_found",
        "Target missing was not found at the selected endpoint.",
        "Refresh target discovery for that endpoint and retry with a returned target ID.",
      ],
      [
        "disallowed-page",
        "target_not_allowed",
        "Target disallowed-page must be an HTTP(S) page in the selected origin scope.",
        "Target disallowed-page must be an HTTP(S) page in the selected origin scope.",
      ],
    ] as const;
    for (const [operation, run] of operations)
      for (const [targetId, reason, detail, remediation] of selections) {
        const result = await run({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: targetId,
        });
        if (result.ok) throw new Error(`${operation} accepted ${targetId}`);
        expect(result.error).toMatchObject({ operation, reason });
        const { details, ...projected } = projectAnalysisError(result.error);
        expect(details).toEqual({ operation, reason });
        expect(projected).toMatchObject({
          code: "target_unavailable",
          message: detail,
          remediation: { action: remediation },
        });
      }
    expect(browser.commands).toHaveLength(0);
    expect(browser.openedConnectionCount()).toBe(0);
  });
});
