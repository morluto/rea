import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
} from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

describe("CdpBrowserProvider: discovery authorization 1", () => {
  it("discovers pages and captures a selected target without an origin list", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({ cdp_endpoint: browser.endpoint }),
    );

    if (!listed.ok) throw listed.error;
    expect(listed.value.targets.map(({ target_id }) => target_id)).toContain(
      "allowed-page",
    );
    expect(listed.value.excluded.disallowed_origin).toBe(0);

    const inspected = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.target.origin).toBe(browser.allowedOrigin);
  });

  it("filters by exact origin and preserves local URL details", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const result = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.targets).toEqual([
      expect.objectContaining({
        target_id: "allowed-page",
        origin: browser.allowedOrigin,
        url: `${browser.allowedOrigin}/app?token=page-secret#fragment`,
      }),
    ]);
    expect(result.value.excluded).toEqual({
      disallowed_origin: 1,
      unsupported_url: 1,
      non_page: 1,
    });
    expect(JSON.stringify(result.value)).not.toContain("forbidden");
    expect(JSON.stringify(result.value)).toContain("page-secret#fragment");
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

  it("uses page-scoped discovery sockets as direct target transports", async () => {
    const browser = await startFakeCdpBrowser({
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
      additionalPageWithWebSocket: true,
      additionalPageWithoutWebSocket: true,
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
      }),
    );
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets.map(({ target_id }) => target_id)).toEqual([
      "allowed-page",
      "allowed-page-with-socket",
    ]);
    expect(listed.value.limitations).toContain(
      "1 otherwise allowed page target(s) lacked a validated direct CDP WebSocket and were excluded.",
    );

    const inspected = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.target.target_id).toBe("allowed-page");
    expect(inspected.value.network.requests).toHaveLength(1);

    const second = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page-with-socket",
        observation_ms: 0,
      }),
    );
    if (!second.ok) throw second.error;
    expect(second.value.target.target_id).toBe("allowed-page-with-socket");
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).not.toContain("Target.attachToTarget");
    expect(methods).not.toContain("Target.detachFromTarget");
    expect(
      browser.commands.every(({ sessionId }) => sessionId === undefined),
    ).toBe(true);
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

  it("rejects missing and disallowed page targets before attaching", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    for (const targetId of ["missing", "disallowed-page"]) {
      const result = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: targetId,
          observation_ms: 0,
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          _tag: "BrowserObservationError",
          reason:
            targetId === "missing" ? "target_not_found" : "target_not_allowed",
        });
    }
    expect(browser.commands).toHaveLength(0);
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
