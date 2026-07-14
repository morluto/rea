import { afterEach, describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../src/browser/CdpBrowserProvider.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
  webPageInspectionSchema,
} from "../src/domain/browserObservation.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "./fixtures/fakeCdpBrowser.js";

describe("CdpBrowserProvider", () => {
  const browsers: FakeCdpBrowser[] = [];

  afterEach(async () => {
    await Promise.all(
      browsers.splice(0).map(async (browser) => browser.close()),
    );
  });

  it("lists only exact-origin pages and sanitizes URLs", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const provider = new CdpBrowserProvider();
    const result = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        approved: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.targets.items).toEqual([
      expect.objectContaining({
        target_id: "allowed-page",
        origin: browser.allowedOrigin,
        url: `${browser.allowedOrigin}/app?token=%5BREDACTED%5D`,
      }),
    ]);
    expect(result.value.excluded).toEqual({
      disallowed_origin: 1,
      unsupported_url: 1,
      non_page: 1,
    });
    expect(JSON.stringify(result.value)).not.toContain("forbidden");
    expect(JSON.stringify(result.value)).not.toContain("page-secret");
  });

  it("captures bounded passive evidence without retaining sensitive values", async () => {
    const browser = await startFakeCdpBrowser({ foreignSessionEvents: true });
    browsers.push(browser);
    const provider = new CdpBrowserProvider();
    const result = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_storage_keys: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(() => webPageInspectionSchema.parse(result.value)).not.toThrow();
    expect(result.value.frames).toHaveLength(1);
    expect(result.value.dom.nodes).toHaveLength(2);
    expect(result.value.dom.nodes[1]?.attribute_names).toEqual(["token"]);
    expect(result.value.accessibility.nodes[0]?.name).toBe("Submit report");
    expect(result.value.scripts.items).toHaveLength(1);
    expect(result.value.scripts.items[0]?.script_id).toBe("script-allowed");
    expect(result.value.scripts.items[0]?.source).toEqual({
      included: false,
      reason: "source capture was not approved",
    });
    expect(result.value.resources).toHaveLength(1);
    expect(result.value.network.requests).toHaveLength(1);
    expect(result.value.network.websocket_events).toEqual([
      {
        request_id: "websocket-1",
        direction: "sent",
        opcode: 1,
        payload_bytes: Buffer.byteLength("websocket-secret"),
      },
    ]);
    expect(result.value.console.events[0]?.argument_types).toEqual(["string"]);
    expect(result.value.workers).toHaveLength(1);
    expect(result.value.storage).toEqual(
      expect.objectContaining({
        local_storage_keys: ["public-key"],
        session_storage_keys: ["public-key"],
        indexed_db_names: ["app-db"],
        cache_names: ["assets-v1"],
        values_redacted: true,
      }),
    );
    const serialized = JSON.stringify(result.value);
    for (const secret of [
      "page-secret",
      "frame-secret",
      "dom-secret",
      "forbidden",
      "resource-secret",
      "script-secret",
      "inline-secret",
      "map-secret",
      "network-secret",
      "request-secret",
      "request-body-secret",
      "response-secret",
      "websocket-secret",
      "websocket-url-secret",
      "console-secret",
      "unknown-origin-console-secret",
      "unknown-console-value-secret",
      "storage-secret",
      "secret-id",
    ])
      expect(serialized).not.toContain(secret);
    const methods = browser.commands.map((command) => command.method);
    expect(methods).toContain("Target.detachFromTarget");
    expect(methods).not.toContain("Browser.close");
    expect(methods).not.toContain("Target.closeTarget");
    expect(methods).not.toContain("Runtime.evaluate");
  });

  it("includes allowed script source only after explicit approval", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const provider = new CdpBrowserProvider();
    const result = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_script_sources: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.scripts.items[0]?.source).toEqual(
      expect.objectContaining({
        included: true,
        content: "export const observed = 'source-secret';",
        bytes: 40,
      }),
    );
    expect(browser.commands.map((command) => command.method)).toContain(
      "Debugger.getScriptSource",
    );
  });

  it("rejects missing and disallowed page targets before attaching", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const provider = new CdpBrowserProvider();
    for (const targetId of ["missing", "disallowed-page"]) {
      const result = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: targetId,
          approved: true,
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
    browsers.push(malformed);
    const malformedResult = await new CdpBrowserProvider().listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: malformed.endpoint,
        allowed_origins: [malformed.allowedOrigin],
        approved: true,
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
    browsers.push(disconnecting);
    const disconnectedResult = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: disconnecting.endpoint,
        allowed_origins: [disconnecting.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    expect(disconnectedResult).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "disconnected" },
    });
  });

  it("reports configured truncation without over-reading DOM or script source", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_script_sources: true,
        limits: {
          max_frames: 1,
          max_dom_nodes: 1,
          max_ax_nodes: 1,
          max_scripts: 1,
          max_resources: 1,
          max_workers: 1,
          max_storage_keys: 1,
          max_script_source_bytes: 10,
          max_total_script_source_bytes: 10,
          max_network_events: 1,
          max_console_events: 1,
          max_websocket_events: 1,
        },
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.completeness).toMatchObject({
      status: "truncated",
      truncated_sections: ["dom", "script_sources"],
    });
    expect(result.value.dom).toMatchObject({ total_nodes: 2 });
    expect(result.value.dom.nodes).toHaveLength(1);
    expect(result.value.scripts.items[0]?.source).toMatchObject({
      included: false,
      reason: "declared script length exceeds per-script limit",
    });
    expect(browser.commands.map(({ method }) => method)).not.toContain(
      "Debugger.getScriptSource",
    );
  });

  it("bounds frames, resources, workers, accessibility, and storage inventories", async () => {
    const browser = await startFakeCdpBrowser({ extraCollections: true });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_storage_keys: true,
        limits: {
          max_frames: 1,
          max_dom_nodes: 2,
          max_ax_nodes: 1,
          max_scripts: 1,
          max_resources: 1,
          max_workers: 1,
          max_storage_keys: 1,
          max_script_source_bytes: 10,
          max_total_script_source_bytes: 10,
          max_network_events: 1,
          max_console_events: 1,
          max_websocket_events: 1,
        },
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.completeness).toMatchObject({
      status: "truncated",
      truncated_sections: [
        "accessibility",
        "frames",
        "resources",
        "storage_keys",
        "workers",
      ],
    });
    expect(result.value.frames).toHaveLength(1);
    expect(result.value.resources).toHaveLength(1);
    expect(result.value.workers).toHaveLength(1);
    expect(result.value.accessibility).toMatchObject({ total_nodes: 2 });
    expect(result.value.accessibility.nodes).toHaveLength(1);
    expect(result.value.storage.local_storage_keys).toHaveLength(1);
    expect(result.value.storage.session_storage_keys).toHaveLength(1);
    expect(result.value.storage.indexed_db_names).toHaveLength(1);
    expect(result.value.storage.cache_names).toHaveLength(1);
  });

  it("degrades optional domains but propagates protocol and payload failures", async () => {
    const optional = await startFakeCdpBrowser({
      unsupportedMethods: ["Accessibility.getFullAXTree"],
    });
    browsers.push(optional);
    const degraded = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: optional.endpoint,
        allowed_origins: [optional.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    if (!degraded.ok) throw degraded.error;
    expect(degraded.value.accessibility.nodes).toEqual([]);
    expect(degraded.value.limitations).toContain(
      "Accessibility.getFullAXTree was unavailable from this browser target.",
    );

    for (const [options, reason] of [
      [{ oversizedDiscovery: true }, "payload_limit"],
      [{ invalidBrowserWebSocket: true }, "invalid_endpoint_response"],
    ] as const) {
      const failed = await startFakeCdpBrowser(options);
      browsers.push(failed);
      const result = await new CdpBrowserProvider().listTargets(
        listBrowserTargetsInputSchema.parse({
          cdp_endpoint: failed.endpoint,
          allowed_origins: [failed.allowedOrigin],
          approved: true,
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          _tag: "BrowserObservationError",
          reason,
        });
    }

    const malformed = await startFakeCdpBrowser({
      malformedMessageOnMethod: "Page.getFrameTree",
    });
    browsers.push(malformed);
    const protocol = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: malformed.endpoint,
        allowed_origins: [malformed.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    expect(protocol).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "protocol_error" },
    });

    const malformedEvent = await startFakeCdpBrowser({
      malformedEventOnMethod: "Debugger.enable",
    });
    browsers.push(malformedEvent);
    const eventProtocol = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: malformedEvent.endpoint,
        allowed_origins: [malformedEvent.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    expect(eventProtocol).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "protocol_error" },
    });

    const malformedEventShape = await startFakeCdpBrowser({
      malformedEventShapeOnMethod: "Debugger.enable",
    });
    browsers.push(malformedEventShape);
    const eventShapeProtocol = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: malformedEventShape.endpoint,
        allowed_origins: [malformedEventShape.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    expect(eventShapeProtocol).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "protocol_error" },
    });
  });

  it("cancels observation and still detaches without closing the page", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const controller = new AbortController();
    const pending = new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 1_000,
      }),
      { signal: controller.signal },
    );
    await waitForCommand(browser, "Target.attachToTarget");
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).toContain("Target.detachFromTarget");
    expect(methods).not.toContain("Target.closeTarget");
    expect(methods).not.toContain("Browser.close");
  });

  it("waits for navigation commit and rechecks the attached main-frame origin", async () => {
    const transitioning = await startFakeCdpBrowser({
      transitionalFrameReads: 2,
    });
    browsers.push(transitioning);
    const input = (browser: FakeCdpBrowser) =>
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      });
    const committed = await new CdpBrowserProvider().inspectPage(
      input(transitioning),
    );
    if (!committed.ok) throw committed.error;
    expect(committed.value.target.origin).toBe(transitioning.allowedOrigin);
    expect(
      transitioning.commands.filter(
        ({ method }) => method === "Page.getFrameTree",
      ),
    ).toHaveLength(5);

    const navigated = await startFakeCdpBrowser({
      attachedFrameUrl: "https://unapproved.example.test/after-attach",
    });
    browsers.push(navigated);
    const denied = await new CdpBrowserProvider().inspectPage(input(navigated));
    expect(denied).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "target_not_allowed" },
    });
    const methods = navigated.commands.map(({ method }) => method);
    expect(methods).toContain("Target.detachFromTarget");
    expect(methods).not.toContain("DOMSnapshot.captureSnapshot");
    expect(methods).not.toContain("Storage.getUsageAndQuota");

    const duringObservation = await startFakeCdpBrowser({
      navigateDuringObservationUrl:
        "https://unapproved.example.test/during-observation",
    });
    browsers.push(duringObservation);
    const interrupted = await new CdpBrowserProvider().inspectPage(
      input(duringObservation),
    );
    expect(interrupted).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "target_not_allowed" },
    });
    expect(
      duringObservation.commands.map(({ method }) => method),
    ).not.toContain("Accessibility.getFullAXTree");

    const captureOptions: { navigateDuringCaptureUrl?: string } = {};
    const duringCapture = await startFakeCdpBrowser(captureOptions);
    captureOptions.navigateDuringCaptureUrl = `${duringCapture.allowedOrigin}/changed`;
    browsers.push(duringCapture);
    const discarded = await new CdpBrowserProvider().inspectPage(
      input(duringCapture),
    );
    expect(discarded).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "target_changed" },
    });
    expect(duringCapture.commands.map(({ method }) => method)).toContain(
      "Target.detachFromTarget",
    );

    const crossOriginCapture = await startFakeCdpBrowser({
      navigateDuringCaptureUrl:
        "https://unapproved.example.test/during-capture",
    });
    browsers.push(crossOriginCapture);
    const rejectedCapture = await new CdpBrowserProvider().inspectPage(
      input(crossOriginCapture),
    );
    expect(rejectedCapture).toMatchObject({
      ok: false,
      error: { _tag: "BrowserObservationError", reason: "target_not_allowed" },
    });
  });
});

const waitForCommand = async (
  browser: FakeCdpBrowser,
  method: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (browser.commands.some((command) => command.method === method)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for fake CDP command ${method}`);
};
