import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

describe("CdpBrowserProvider: approved accessibility and source capture", () => {
  it("captures approved accessibility text inline", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const request = inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
      include_accessibility_text: true,
    });
    const result = await new CdpBrowserProvider().inspectPage(request);

    if (!result.ok) throw result.error;
    expect(result.value.accessibility).toMatchObject({
      text_capture: {
        status: "included",
        retained_bytes: 27,
      },
      nodes: [expect.objectContaining({ name: "Submit report" })],
    });
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
        observation_ms: 0,
        include_script_sources: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.scripts.items[0]?.source).toEqual(
      expect.objectContaining({
        included: true,
        artifact: expect.objectContaining({
          text: "export const observed = 'source-secret';",
          bytes: 40,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      }),
    );
    expect(browser.commands.map((command) => command.method)).toContain(
      "Debugger.getScriptSource",
    );
  });

  it.each([{}, { scriptSource: null }, { scriptSource: 123 }])(
    "rejects malformed source replies instead of inventing empty source: %j",
    async (reply) => {
      const browser = await startFakeCdpBrowser({
        commandResult: ({ method }) =>
          method === "Debugger.getScriptSource" ? reply : undefined,
      });
      trackBrowser(browser);
      const result = await new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          observation_ms: 0,
          include_script_sources: true,
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          operation: "inspect_web_page",
          reason: "protocol_error",
          userMessage: expect.stringContaining("scriptSource must be a string"),
        },
      });
      expect(browser.commands.map(({ method }) => method)).toContain(
        "Target.detachFromTarget",
      );
    },
  );

  it("retains an explicitly empty producer script", async () => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Debugger.getScriptSource"
          ? { scriptSource: "" }
          : undefined,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        observation_ms: 0,
        include_script_sources: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.scripts.items[0]?.source).toMatchObject({
      included: true,
      artifact: { text: "", bytes: 0 },
    });
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
        observation_ms: 0,
        fetch_source_maps: true,
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

describe("CdpBrowserProvider: transient WebMCP frames", () => {
  it("drops stale child tools and reports partial coverage when a blank commit remains", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpChildTransientBlank: true,
      extraCollections: true,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.tools.items.map(({ name }) => name)).not.toContain(
      "child_tool",
    );
    expect(result.value.completeness.attach_limited_sections).toContain(
      "webmcp_tools",
    );
    expect(
      result.value.completeness.excluded.find(
        ({ section }) => section === "webmcp_tools",
      )?.count,
    ).toBe(1);
  });

  it("accepts fresh child registrations after a stable frame commit", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpChildRecoversAfterTransient: true,
      webMcpChildTransientBlank: true,
      extraCollections: true,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.tools.items).toContainEqual(
      expect.objectContaining({ name: "child_tool" }),
    );
    expect(result.value.completeness.attach_limited_sections).not.toContain(
      "webmcp_tools",
    );
  });

  it("drops registrations from a child document when that frame commits a replacement", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpChildNavigatesAllowed: true,
      extraCollections: true,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.tools.items.map(({ name }) => name)).not.toContain(
      "child_tool",
    );
    expect(
      result.value.completeness.excluded.find(
        ({ section }) => section === "webmcp_tools",
      )?.count,
    ).toBe(1);
  });
});

describe("CdpBrowserProvider: WebMCP discovery and completeness", () => {
  it("discovers untrusted WebMCP declarations without registering or invoking them", async () => {
    const browser = await startFakeCdpBrowser({ webMcpTools: true });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
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
            description: "Search orders; authorization=Bearer tool-secret",
            declaration_kind: "declarative",
            owner_origin: browser.allowedOrigin,
            annotations: {
              read_only: true,
              untrusted_content: true,
              autosubmit: false,
            },
            trust: "page-declared-untrusted",
            registration_source: {
              url: `${browser.allowedOrigin}/app.js?token=tool-source-secret`,
              line: 12,
              column: 4,
            },
          },
        ],
      },
    });
    const serialized = JSON.stringify(result.value);
    expect(serialized).toContain("tool-secret");
    expect(serialized).toContain("tool-source-secret");
    for (const secret of ["schema-secret", "private-tool-secret"])
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

  it("returns every WebMCP registration in the replay", async () => {
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
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.tools).toMatchObject({
      total: 2,
      items: [expect.any(Object), expect.any(Object)],
    });
    expect(result.value.completeness.truncated_sections).not.toContain(
      "webmcp_tools",
    );
  });

  it("retains registrations from authorized frames beyond the former frame cap", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpFrameCount: 1_001,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.tools.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "beyond_frame_limit_tool",
          frame_id: "webmcp-frame-1000",
        }),
      ]),
    );
    expect(result.value.completeness.truncated_sections).not.toContain(
      "webmcp_tools",
    );
  });
});

describe("CdpBrowserProvider WebMCP inventory completeness", () => {
  it("retains every field in a large declared WebMCP input schema", async () => {
    const propertyCount = 5_001;
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpSchemaPropertyCount: propertyCount,
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    const shape = result.value.tools.items[0]?.input_schema_shape;
    expect(
      shape?.properties.filter(({ path }) =>
        path.startsWith("/properties/field_"),
      ),
    ).toHaveLength(propertyCount * 2);
    expect(shape?.properties).toContainEqual({
      path: "/properties/field_5000/type",
      types: ["string"],
      observations: 1,
    });
  });
});

describe("CdpBrowserProvider: frame scope and screenshots", () => {
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
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      viewport: { width: 1, height: 1 },
      artifact: {
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
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
});

describe("CdpBrowserProvider: complete passive inventories", () => {
  it("returns every frame, resource, worker, accessibility, and storage inventory item", async () => {
    const browser = await startFakeCdpBrowser({ extraCollections: true });
    trackBrowser(browser);
    const request = inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
      include_storage_keys: true,
    });
    const result = await new CdpBrowserProvider().inspectPage(request);
    if (!result.ok) throw result.error;
    expect(result.value.completeness.truncated_sections).toEqual([]);
    expect(result.value.frames.length).toBeGreaterThan(1);
    expect(result.value.resources.length).toBeGreaterThan(1);
    expect(result.value.workers.length).toBeGreaterThan(1);
    expect(result.value.accessibility).toMatchObject({ total_nodes: 4 });
    expect(result.value.accessibility.nodes).toHaveLength(4);
    expect(result.value.storage.local_storage_keys.length).toBeGreaterThan(1);
    expect(result.value.storage.session_storage_keys.length).toBeGreaterThan(1);
    expect(result.value.storage.indexed_db_names).toHaveLength(2);
    expect(result.value.storage.cache_names).toHaveLength(2);
    expect(result.value.storage.content_fingerprints).toEqual([]);
  });
});

describe("CdpBrowserProvider: WebMCP registration owners", () => {
  it.each(["retain", "remove-second"] as const)(
    "keeps same-URL frame owners separate: %s",
    async (mode) => {
      const browser = await startFakeCdpBrowser({
        webMcpSameUrlRegistrations: mode,
      });
      trackBrowser(browser);
      const result = await new CdpBrowserProvider().discoverWebMcpTools(
        discoverWebMcpToolsInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!result.ok) throw result.error;
      const tools = result.value.tools.items;
      expect(tools).toHaveLength(mode === "retain" ? 2 : 1);
      expect(result.value.tools.total).toBe(tools.length);
      expect(tools).toContainEqual(
        expect.objectContaining({
          name: "read_item",
          frame_id: "webmcp-frame-0",
          description: "First owner updated",
        }),
      );
      if (mode === "retain") {
        expect(tools).toContainEqual(
          expect.objectContaining({
            name: "read_item",
            frame_id: "webmcp-frame-1",
            description: "Second owner",
          }),
        );
        expect(new Set(tools.map((tool) => tool.tool_key)).size).toBe(2);
        expect(new Set(tools.map((tool) => tool.frame_url)).size).toBe(1);
      }
      expect(browser.commands.map(({ method }) => method)).not.toContain(
        "WebMCP.invokeTool",
      );
      expect(browser.commands.map(({ method }) => method)).not.toContain(
        "Runtime.evaluate",
      );
    },
  );
});
