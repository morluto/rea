import { describe, expect, it } from "vitest";

import {
  browserEndpointSchema,
  browserOriginSchema,
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
  sanitizeBrowserUrl,
} from "../src/domain/browserObservation.js";
import { captureWebScreenshotInputSchema } from "../src/domain/webScreenshot.js";

describe("browser observation contracts", () => {
  it("normalizes exact HTTP origins without accepting broader URL scopes", () => {
    expect(browserOriginSchema.parse("https://Example.COM:443")).toBe(
      "https://example.com",
    );
    expect(browserOriginSchema.parse("http://example.com:80")).toBe(
      "http://example.com",
    );
    for (const value of [
      "https://*.example.com",
      "https://example.com/path",
      "https://example.com/?token=secret",
      "https://user:pass@example.com",
      "file:///tmp/page.html",
    ])
      expect(browserOriginSchema.safeParse(value).success, value).toBe(false);
  });

  it("accepts only literal loopback HTTP CDP endpoints", () => {
    expect(browserEndpointSchema.parse("http://127.0.0.1:9222")).toBe(
      "http://127.0.0.1:9222",
    );
    expect(browserEndpointSchema.parse("http://[::1]:9222")).toBe(
      "http://[::1]:9222",
    );
    for (const value of [
      "http://localhost:9222",
      "http://192.168.1.2:9222",
      "https://127.0.0.1:9222",
      "http://127.0.0.1:9222/json/list",
      "http://user:pass@127.0.0.1:9222",
    ])
      expect(browserEndpointSchema.safeParse(value).success, value).toBe(false);
  });

  it("applies conservative bounded defaults to public tool input", () => {
    expect(
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        allowed_origins: ["https://app.example.test"],
        approved: true,
      }),
    ).toEqual({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: ["https://app.example.test"],
      approved: true,
      offset: 0,
      limit: 100,
    });
    expect(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        allowed_origins: ["https://app.example.test"],
        target_id: "page-1",
        approved: true,
      }),
    ).toMatchObject({
      observation_ms: 500,
      include_accessibility_text: false,
      include_console_text: false,
      console_text_approved: false,
      include_json_body_shapes: false,
      json_body_schema_approved: false,
      include_websocket_shapes: false,
      websocket_shape_approved: false,
      include_script_sources: false,
      include_storage_keys: false,
      limits: {
        max_frames: 200,
        max_dom_nodes: 2_000,
        max_ax_nodes: 2_000,
        max_ax_text_field_bytes: 1_024,
        max_total_ax_text_bytes: 65_536,
        max_scripts: 200,
        max_resources: 2_000,
        max_workers: 500,
        max_storage_keys: 1_000,
        max_script_source_bytes: 1_048_576,
        max_total_script_source_bytes: 4_194_304,
        max_network_events: 1_000,
        max_console_events: 200,
        max_console_text_field_bytes: 1_024,
        max_total_console_text_bytes: 65_536,
        max_json_body_bytes: 1_048_576,
        max_total_json_body_bytes: 4_194_304,
        max_json_shape_nodes: 5_000,
        max_json_shape_depth: 20,
        max_websocket_events: 500,
        max_websocket_shape_bytes: 65_536,
        max_total_websocket_shape_bytes: 1_048_576,
      },
    });
  });

  it("requires independent approval for each sensitive capture surface", () => {
    const base = {
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: ["https://app.example.test"],
      target_id: "page-1",
      approved: true,
    };
    for (const input of [
      { include_console_text: true },
      { include_json_body_shapes: true },
      { include_websocket_shapes: true },
    ])
      expect(
        inspectWebPageInputSchema.safeParse({ ...base, ...input }).success,
      ).toBe(false);
  });

  it("requires an independent literal approval for screenshot pixels", () => {
    const input = {
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: ["https://app.example.test"],
      target_id: "page-1",
      approved: true,
    };
    expect(captureWebScreenshotInputSchema.safeParse(input).success).toBe(
      false,
    );
    expect(
      captureWebScreenshotInputSchema.safeParse({
        ...input,
        screenshot_approved: true,
      }).success,
    ).toBe(true);
  });

  it("removes credentials, query values, and fragments from observed URLs", () => {
    expect(
      sanitizeBrowserUrl(
        "https://user:pass@app.example.test/path?token=secret&mode=full#part",
      ),
    ).toEqual({
      url: "https://app.example.test/path?mode=%5BREDACTED%5D&token=%5BREDACTED%5D",
      origin: "https://app.example.test",
      query_parameter_names: ["mode", "token"],
      redacted: true,
    });
  });

  it("bounds retained URL and query-name metadata", () => {
    const longName = `a${"x".repeat(400)}`;
    const parameters = [
      `${longName}=secret`,
      ...Array.from(
        { length: 300 },
        (_value, index) => `k${String(index).padStart(3, "0")}=secret`,
      ),
    ].join("&");
    const sanitized = sanitizeBrowserUrl(
      `https://app.example.test/path?${parameters}`,
    );
    expect(sanitized.query_parameter_names).toHaveLength(256);
    expect(
      sanitized.query_parameter_names.every((name) => name.length <= 256),
    ).toBe(true);
    expect(sanitized.url).not.toContain("secret");

    const oversized = sanitizeBrowserUrl(
      `https://app.example.test/${"p".repeat(70_000)}`,
    );
    expect(oversized.origin).toBe("https://app.example.test");
    expect(oversized.url.length).toBeLessThanOrEqual(131_072);
    expect(oversized.redacted).toBe(true);
  });
});
