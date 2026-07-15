import { afterEach, describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../src/browser/CdpBrowserProvider.js";
import {
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
  webPageInspectionSchema,
} from "../src/domain/browserObservation.js";
import { analyzeWebBundleInputSchema } from "../src/domain/webBundleAnalysis.js";
import { observeWebSessionInputSchema } from "../src/domain/browserSession.js";
import { discoverWebMcpToolsInputSchema } from "../src/domain/webMcpDiscovery.js";
import { captureWebScreenshotInputSchema } from "../src/domain/webScreenshot.js";
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

  it("sanitizes URL-shaped transitional target titles", async () => {
    const browser = await startFakeCdpBrowser({
      urlShapedAllowedTitle: true,
    });
    browsers.push(browser);
    const provider = new CdpBrowserProvider();
    const input = {
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      approved: true as const,
      target_id: "allowed-page",
    };
    const listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse(input),
    );
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets.items[0]?.title).toBe(
      `${browser.allowedOrigin}/app?startup=%5BREDACTED%5D`,
    );

    const inspected = await provider.inspectPage(
      inspectWebPageInputSchema.parse({ ...input, observation_ms: 0 }),
    );
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.target.title).toBe(
      `${browser.allowedOrigin}/app?startup=%5BREDACTED%5D`,
    );
    expect(JSON.stringify({ listed, inspected })).not.toContain("title-secret");
  });

  it("uses page-scoped discovery sockets as direct target transports", async () => {
    const browser = await startFakeCdpBrowser({
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
      additionalPageWithWebSocket: true,
      additionalPageWithoutWebSocket: true,
    });
    browsers.push(browser);
    const provider = new CdpBrowserProvider();
    const listed = await provider.listTargets(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        approved: true,
      }),
    );
    if (!listed.ok) throw listed.error;
    expect(
      listed.value.targets.items.map(({ target_id }) => target_id),
    ).toEqual(["allowed-page", "allowed-page-with-socket"]);
    expect(listed.value.limitations).toContain(
      "1 otherwise allowed page target(s) lacked a validated direct CDP WebSocket and were excluded.",
    );

    const inspected = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
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
        approved: true,
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

  it("projects direct-session cancellation onto the requested operation", async () => {
    const browser = await startFakeCdpBrowser({
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
    });
    browsers.push(browser);
    const controller = new AbortController();
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 1_000,
      }),
      {
        signal: controller.signal,
        progress: {
          report(update) {
            if (update.completed === 1) controller.abort();
            return Promise.resolve();
          },
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "observe_web_session",
      },
    });
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).not.toContain("Target.attachToTarget");
    expect(methods).not.toContain("Target.detachFromTarget");
    expect(methods).not.toContain("Target.closeTarget");
    expect(methods).not.toContain("Browser.close");
  });

  it("projects capture-window cancellation onto bundle analysis", async () => {
    const browser = await startFakeCdpBrowser({
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
    });
    browsers.push(browser);
    const controller = new AbortController();
    const result = await new CdpBrowserProvider().analyzeBundle(
      analyzeWebBundleInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        source_capture_approved: true,
        observation_ms: 1_000,
      }),
      {
        signal: controller.signal,
        progress: {
          report(update) {
            if (update.completed === 2) controller.abort();
            return Promise.resolve();
          },
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "analyze_web_bundle",
      },
    });
  });

  it("rejects empty browser attachment session identifiers", async () => {
    const browser = await startFakeCdpBrowser({ invalidAttachedSession: true });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
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

  it("captures bounded passive evidence without retaining sensitive values", async () => {
    const browser = await startFakeCdpBrowser({
      binaryWebSocketEvent: true,
      foreignSessionEvents: true,
      unrelatedWorker: true,
    });
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
    expect(result.value.dom.nodes[1]?.attribute_names).toEqual([
      "token",
      "href",
      "rel",
    ]);
    expect(result.value.accessibility).toMatchObject({
      text_capture: {
        status: "not_approved",
        retained_bytes: 0,
      },
      nodes: [expect.objectContaining({ name: null, description: null })],
    });
    expect(result.value.scripts.items).toHaveLength(1);
    expect(result.value.scripts.items[0]?.script_key).toMatch(
      /^scr_[a-f0-9]{64}$/u,
    );
    expect(result.value.scripts.items[0]?.source_map_url).toBe(
      `${browser.allowedOrigin}/app.js.map?token=%5BREDACTED%5D`,
    );
    expect(result.value.scripts.items[0]?.resource_reconciliation).toEqual({
      status: "exact",
      resource_key: result.value.resources[0]?.resource_key,
    });
    expect(result.value.scripts.items[0]?.source).toEqual({
      included: false,
      reason: "source capture was not approved",
    });
    expect(result.value.resources).toHaveLength(1);
    expect(result.value.network.requests).toHaveLength(1);
    expect(result.value.network.requests[0]?.initiator).toEqual({
      type: "script",
      url: `${browser.allowedOrigin}/app.js?caller=%5BREDACTED%5D`,
      line: 3,
      column: 5,
    });
    expect(result.value.network.websocket_events).toEqual([
      {
        request_id: "websocket-1",
        direction: "sent",
        opcode: 1,
        payload_bytes: Buffer.byteLength("websocket-secret"),
        payload_shape: null,
      },
      {
        request_id: "websocket-1",
        direction: "received",
        opcode: 2,
        payload_bytes: 3,
        payload_shape: null,
      },
    ]);
    expect(result.value.console.events[0]?.argument_types).toEqual(["string"]);
    expect(result.value.workers).toHaveLength(1);
    expect(result.value.metadata).toMatchObject({
      headers_allowlisted: true,
      responses: [
        {
          content_length: 321,
          content_encoding: "br",
          csp: { nonce_count: 1, hash_count: 1 },
          policies: {
            coop: "same-origin",
            coep: "require-corp",
            permissions_policy_features: ["camera", "geolocation"],
          },
        },
      ],
      dom_urls: [
        {
          attribute: "href",
          url: `${browser.allowedOrigin}/agent?token=%5BREDACTED%5D`,
          destination_scope: "approved",
        },
      ],
      agent_hints: expect.arrayContaining([
        expect.objectContaining({
          mechanism: "link_rel",
          declaration: "mcp service-desc",
        }),
        expect.objectContaining({
          mechanism: "dom_link_rel",
          declaration: "mcp",
        }),
        expect.objectContaining({
          mechanism: "response_header",
          declaration: "x-model-context",
        }),
      ]),
    });
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
      "response-body-secret",
      "websocket-secret",
      "websocket-url-secret",
      "console-secret",
      "unknown-origin-console-secret",
      "unknown-console-value-secret",
      "storage-secret",
      "secret-id",
      "dom-url-secret",
      "link-secret",
      "csp-secret",
      "hash-secret",
      "header-secret",
    ])
      expect(serialized).not.toContain(secret);
    const methods = browser.commands.map((command) => command.method);
    expect(methods).toContain("Target.detachFromTarget");
    expect(methods).not.toContain("Browser.close");
    expect(methods).not.toContain("Target.closeTarget");
    expect(methods).not.toContain("Runtime.evaluate");
    expect(methods).not.toContain("Network.getResponseBody");
  });

  it("captures only approved redacted console text and value-free payload shapes", async () => {
    const browser = await startFakeCdpBrowser({
      sensitiveShapes: true,
      binaryWebSocketEvent: true,
    });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_console_text: true,
        console_text_approved: true,
        include_json_body_shapes: true,
        json_body_schema_approved: true,
        include_websocket_shapes: true,
        websocket_shape_approved: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.console.events[0]?.text_capture).toEqual({
      status: "included",
      values: [
        { argument_index: 0, type: "string", text: "authorization=[REDACTED]" },
        { argument_index: 1, type: "number", text: "42" },
      ],
      retained_bytes: 26,
      truncated_values: 0,
    });
    expect(result.value.network.requests[0]?.body_shapes).toMatchObject({
      status: "included",
      request: {
        root_type: "object",
        properties: expect.arrayContaining([
          expect.objectContaining({ path: "/token", types: ["string"] }),
          expect.objectContaining({
            path: "/filters/active",
            types: ["boolean"],
          }),
        ]),
      },
      response: {
        root_type: "object",
        properties: expect.arrayContaining([
          expect.objectContaining({
            path: "/result/token",
            types: ["string"],
          }),
          expect.objectContaining({ path: "/items/*/id", types: ["number"] }),
        ]),
      },
    });
    expect(result.value.network.websocket_events).toEqual([
      expect.objectContaining({
        opcode: 1,
        payload_shape: expect.objectContaining({
          format: "json",
          json_shape: expect.objectContaining({
            properties: expect.arrayContaining([
              expect.objectContaining({ path: "/token", types: ["string"] }),
            ]),
          }),
        }),
      }),
      expect.objectContaining({
        opcode: 2,
        payload_shape: {
          format: "binary",
          json_shape: null,
          truncated: false,
        },
      }),
    ]);
    const serialized = JSON.stringify(result.value);
    for (const secret of [
      "request-body-secret",
      "response-body-secret",
      "websocket-secret",
      "console-secret",
      "object-secret",
    ])
      expect(serialized).not.toContain(secret);
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).toContain("Network.getResponseBody");
    expect(methods).not.toContain("Runtime.getProperties");
    expect(methods).not.toContain("Runtime.callFunctionOn");
  });

  it("reports independent sensitive-capture truncation at aggregate byte limits", async () => {
    const browser = await startFakeCdpBrowser({ sensitiveShapes: true });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_console_text: true,
        console_text_approved: true,
        include_json_body_shapes: true,
        json_body_schema_approved: true,
        include_websocket_shapes: true,
        websocket_shape_approved: true,
        limits: {
          max_console_text_field_bytes: 5,
          max_total_console_text_bytes: 5,
          max_json_body_bytes: 10,
          max_total_json_body_bytes: 10,
          max_websocket_shape_bytes: 5,
          max_total_websocket_shape_bytes: 5,
        },
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.console.events[0]?.text_capture).toEqual({
      status: "truncated",
      values: [{ argument_index: 0, type: "string", text: "autho" }],
      retained_bytes: 5,
      truncated_values: 2,
    });
    expect(result.value.network.requests[0]?.body_shapes.status).toBe(
      "truncated",
    );
    expect(result.value.network.websocket_events[0]?.payload_shape).toEqual({
      format: "text",
      json_shape: null,
      truncated: true,
    });
    expect(result.value.completeness.truncated_sections).toEqual(
      expect.arrayContaining([
        "console_text",
        "json_body_shapes",
        "websocket_shapes",
      ]),
    );
  });

  it("fails closed on malformed approved response and binary payload encodings", async () => {
    const browser = await startFakeCdpBrowser({
      invalidResponseBodyBase64: true,
      binaryWebSocketEvent: true,
      invalidBinaryWebSocketEvent: true,
    });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
        include_json_body_shapes: true,
        json_body_schema_approved: true,
        include_websocket_shapes: true,
        websocket_shape_approved: true,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.network.requests[0]?.body_shapes).toMatchObject({
      status: "partial",
      request: expect.any(Object),
      response: null,
    });
    expect(result.value.network.websocket_events[1]).toMatchObject({
      opcode: 2,
      payload_bytes: 0,
      payload_shape: { format: "binary", json_shape: null },
    });
    expect(result.value.completeness.unavailable_sections).toEqual(
      expect.arrayContaining(["json_body_shapes", "websocket_frames"]),
    );
  });

  it("captures bounded accessibility text only after independent approval", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
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

  it("drops network evidence when a request redirects outside the approved origin", async () => {
    const browser = await startFakeCdpBrowser({
      redirectToDisallowedOrigin: true,
    });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.network.requests).toEqual([]);
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
    browsers.push(browser);
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

  it("observes user-driven reload, SPA, redirect, failure, and lifecycle events", async () => {
    const browser = await startFakeCdpBrowser({
      sessionTimeline: "same_origin",
    });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 20,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("window_elapsed");
    expect(result.value.timeline.map(({ type }) => type)).toEqual([
      "navigation_requested",
      "same_origin_reload",
      "same_document_navigation",
      "redirect",
      "load_failed",
      "lifecycle",
    ]);
    expect(result.value.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "same_document_navigation",
          url: `${browser.allowedOrigin}/reloaded?token=%5BREDACTED%5D`,
        }),
        expect.objectContaining({
          type: "load_failed",
          detail: "net::ERR_CONNECTION_REFUSED",
        }),
      ]),
    );
    expect(result.value.completeness.status).toBe("attach_limited");
    expect(JSON.stringify(result.value)).not.toContain("session-secret");
    expect(JSON.stringify(result.value)).not.toContain("redirect-secret");
    expect(browser.commands.map(({ method }) => method)).toContain(
      "Target.detachFromTarget",
    );
  });

  it("ends a browser session when its flat target session detaches", async () => {
    const browser = await startFakeCdpBrowser({
      sessionTimeline: "target_detached",
    });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 1_000,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("target_terminated");
    expect(result.value.timeline.at(-1)).toMatchObject({
      type: "target_terminated",
      detail: "target_terminated",
    });
  });

  it("ends a direct page session when its transport disconnects", async () => {
    const browser = await startFakeCdpBrowser({
      pageScopedVersionWebSocket: true,
      omitTargetWebSocket: true,
      closeAfterMethod: "Page.setLifecycleEventsEnabled",
    });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 1_000,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("target_terminated");
    expect(result.value.timeline.at(-1)).toMatchObject({
      type: "target_terminated",
      detail: "target_terminated",
    });
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).not.toContain("Target.attachToTarget");
    expect(methods).not.toContain("Target.detachFromTarget");
    expect(methods).not.toContain("Target.closeTarget");
  });

  it("discovers untrusted WebMCP declarations without registering or invoking them", async () => {
    const browser = await startFakeCdpBrowser({ webMcpTools: true });
    browsers.push(browser);
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
    browsers.push(browser);
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
    browsers.push(browser);
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
    browsers.push(browser);
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

  it("removes WebMCP declarations after their child frame leaves scope", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      extraCollections: true,
      webMcpChildLeavesScope: true,
    });
    browsers.push(browser);
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
    browsers.push(browser);
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
    browsers.push(browser);
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

  it("ends immediately when a redirect leaves policy without exposing its URL", async () => {
    const browser = await startFakeCdpBrowser({
      sessionTimeline: "outside_policy",
    });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 1_000,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("target_left_scope");
    expect(result.value.timeline.at(-1)).toMatchObject({
      type: "redirect",
      url: null,
      destination_scope: "outside_policy",
    });
    expect(result.value.completeness).toMatchObject({
      status: "policy_filtered",
      policy_filtered_sections: ["timeline"],
      excluded: [
        {
          section: "timeline",
          reason: "out_of_target_scope",
          count: 1,
        },
      ],
    });
    expect(JSON.stringify(result.value)).not.toContain("private.example.test");
  });

  it("fails closed when the final session frame leaves policy without an event", async () => {
    const browser = await startFakeCdpBrowser({
      frameUrlAfterFirstRead: "https://private.example.test/final",
    });
    browsers.push(browser);
    const result = await new CdpBrowserProvider().observeSession(
      observeWebSessionInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 1,
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value.window.end_reason).toBe("target_left_scope");
    expect(result.value.target.final_url).toBeNull();
    expect(result.value.completeness).toMatchObject({
      status: "policy_filtered",
      policy_filtered_sections: ["timeline"],
    });
    expect(JSON.stringify(result.value)).not.toContain("private.example.test");
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
    expect(degraded.value.accessibility.text_capture.status).toBe(
      "unavailable",
    );
    expect(degraded.value.completeness.unavailable_sections).toContain(
      "accessibility",
    );
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
      error: {
        _tag: "AnalysisCancelledError",
        operation: "inspect_web_page",
      },
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
