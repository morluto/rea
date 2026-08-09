import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { describeBrowser, trackBrowser } from "./cdpBrowserProvider.support.js";

describeBrowser("CdpBrowserProvider: document script 1", () => {
  it("captures bounded accessibility text only after independent approval", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_accessibility_text: true,
        limits: {
          max_ax_text_field_bytes: 6,
          max_total_ax_text_bytes: 6,
        },
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.accessibility).toMatchObject({
      text_capture: {
        status: "truncated",
        retained_bytes: 6,
        truncated_fields: 2,
      },
      nodes: [expect.objectContaining({ name: "Submit" })],
    });
    expect(result.value.completeness.truncated_sections).toContain(
      "accessibility",
    );
  });

  it("includes allowed script source only after explicit approval", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const result = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_script_sources: true,
        source_capture_approved: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.scripts.items[0]?.source).toEqual(
      expect.objectContaining({
        included: true,
        artifact: expect.objectContaining({
          text: "export const observed = 'source-secret';",
          bytes: 40,
          uri: expect.stringMatching(/^rea:\/\/web-content\/sha256\//u),
        }),
      }),
    );
    expect(browser.commands.map((command) => command.method)).toContain(
      "Debugger.getScriptSource",
    );
  });

  it("fetches and validates source maps only after separate approval", async () => {
    const browser = await startFakeCdpBrowser({
      sourceMapBody: JSON.stringify({
        version: 3,
        names: [],
        sources: ["src/main.ts"],
        sourcesContent: ["export const original = true;"],
        mappings: "AAAA",
      }),
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().analyzeBundle(
      analyzeWebBundleInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        source_capture_approved: true,
        observation_ms: 0,
        fetch_source_maps: true,
        source_map_fetch_approved: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.observations.source_maps).toMatchObject({
      status: "included",
      items: [
        {
          status: "included",
          original_sources: [
            expect.objectContaining({
              source: `${browser.allowedOrigin}/src/main.ts`,
            }),
          ],
          mappings: [expect.any(Object)],
        },
      ],
    });
    const sourceMapRequest = browser.httpRequests.find(({ url }) =>
      url.startsWith("/app.js.map"),
    );
    expect(sourceMapRequest).toEqual({
      url: "/app.js.map?token=map-secret",
      authorization: undefined,
      cookie: undefined,
      referer: undefined,
    });
  });
});

describeBrowser("CdpBrowserProvider: document script 2", () => {
  it("discovers untrusted WebMCP declarations without registering or invoking them", async () => {
    const browser = await startFakeCdpBrowser({ webMcpTools: true });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      status: "available",
      tools: {
        total: 1,
        items: [
          {
            name: "search_orders",
            description: "Search orders; authorization=[REDACTED]",
            declaration_kind: "declarative",
            owner_origin: browser.allowedOrigin,
            annotations: {
              read_only: true,
              untrusted_content: true,
              autosubmit: false,
            },
            trust: "page-declared-untrusted",
            registration_source: {
              url: `${browser.allowedOrigin}/app.js?token=%5BREDACTED%5D`,
              line: 12,
              column: 4,
            },
          },
        ],
      },
    });
    const serialized = JSON.stringify(result.value);
    for (const secret of [
      "tool-secret",
      "schema-secret",
      "tool-source-secret",
      "private-tool-secret",
    ])
      expect(serialized).not.toContain(secret);
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).toContain("WebMCP.enable");
    expect(methods).not.toContain("WebMCP.invokeTool");
    expect(methods).not.toContain("Runtime.evaluate");
  });

  it("reports WebMCP unavailable when the experimental domain is absent", async () => {
    const browser = await startFakeCdpBrowser({
      unsupportedMethods: ["WebMCP.enable"],
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.status).toBe("unavailable");
    expect(result.value.tools.items).toEqual([]);
    expect(result.value.completeness.unavailable_sections).toContain(
      "webmcp_tools",
    );
  });

  it("rejects WebMCP evidence when the page leaves its approved origin", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      frameUrlAfterFirstRead: "https://private.example.test/tools",
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "discover_webmcp_tools",
        reason: "target_not_allowed",
      },
    });
    expect(browser.commands.map(({ method }) => method)).not.toContain(
      "WebMCP.invokeTool",
    );
  });

  it("bounds WebMCP registration replay and reports dropped declarations", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      extraCollections: true,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        max_tools: 1,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.tools).toMatchObject({
      total: 2,
      items: [expect.any(Object)],
    });
    expect(result.value.completeness).toMatchObject({
      status: "truncated",
      dropped_events: { webmcp_tools: 1 },
    });
  });
});

describeBrowser("CdpBrowserProvider: document script 3", () => {
  it("removes WebMCP declarations after their child frame leaves scope", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      extraCollections: true,
      webMcpChildLeavesScope: true,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    const names = result.value.tools.items.map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining(["search_orders", "update_order"]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining(["child_tool", "escaped_child_tool"]),
    );
    expect(result.value.completeness.policy_filtered_sections).toContain(
      "webmcp_tools",
    );
    expect(JSON.stringify(result.value)).not.toContain(
      "cross-origin-child-secret",
    );
  });

  it("captures an explicitly approved content-addressed viewport screenshot", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        screenshot_approved: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      viewport: { width: 1, height: 1 },
      artifact: {
        uri: expect.stringMatching(/^rea:\/\/web-screenshot\/sha256\//u),
        bytes: 70,
        media_type: "image/png",
      },
    });
    expect(browser.commands.map(({ method }) => method)).toContain(
      "Page.captureScreenshot",
    );
  });

  it("discards screenshot pixels when the main frame navigates during capture", async () => {
    const browser = await startFakeCdpBrowser({
      navigateDuringScreenshotUrl: "https://private.example.test/screenshot",
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        screenshot_approved: true,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "capture_web_screenshot",
        reason: "target_not_allowed",
      },
    });
  });

  it("reports configured truncation without over-reading DOM or script source", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_script_sources: true,
        source_capture_approved: true,
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
});

describeBrowser("CdpBrowserProvider: document script 4", () => {
  it("bounds frames, resources, workers, accessibility, and storage inventories", async () => {
    const browser = await startFakeCdpBrowser({ extraCollections: true });
    trackBrowser(browser);
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
    expect(result.value.storage.content_fingerprints).toEqual([]);
  });
});
