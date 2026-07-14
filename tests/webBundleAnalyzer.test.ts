import { describe, expect, it } from "vitest";

import {
  inspectWebPageInputSchema,
  webPageInspectionSchema,
} from "../src/domain/browserObservation.js";
import { analyzeCapturedWebBundle } from "../src/domain/webBundleAnalyzer.js";
import {
  analyzeWebBundleInputSchema,
  webBundleAnalysisSchema,
} from "../src/domain/webBundleAnalysis.js";
import { createWebTextArtifact } from "../src/domain/webContentArtifact.js";

const origin = "https://app.example.test";

describe("web bundle analyzer", () => {
  it("extracts bounded graph, route, endpoint, vendor, and WebMCP evidence", () => {
    const source = `
      import { createApp } from "./chunk.js?token=secret";
      const lazy = import("./lazy.js");
      const routes = [{ path: "/users/:id?token=secret" }];
      fetch("/api/users?authorization=secret");
      document.modelContext.registerTool({
        name: "lookup-user",
        description: "Untrusted page declaration",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string" },
            verbose: { type: "boolean" }
          }
        }
      });
      const __webpack_require__ = () => createApp(routes, lazy);
    `;
    const result = analyzeCapturedWebBundle(inspection(source), input());

    expect(result.observations.chunks.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "static_import",
          specifier: "./chunk.js?token=secret",
          resolved_url: `${origin}/assets/chunk.js?token=%5BREDACTED%5D`,
        }),
        expect.objectContaining({
          kind: "dynamic_import",
          specifier: "./lazy.js",
        }),
      ]),
    );
    expect(result.observations.routes).toEqual([
      expect.objectContaining({ value: "/users/:id?token=%5BREDACTED%5D" }),
    ]);
    expect(result.observations.endpoints).toEqual([
      expect.objectContaining({
        value: "/api/users?authorization=%5BREDACTED%5D",
      }),
    ]);
    expect(result.observations.webmcp_declarations).toEqual([
      expect.objectContaining({
        name: "lookup-user",
        trust: "page-declared-untrusted",
        schema_property_names: ["userId", "verbose"],
      }),
    ]);
    expect(result.inferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "webpack", confidence: "high" }),
        expect.objectContaining({ value: "Vue" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("authorization=secret");
    expect(result.completeness.status).toBe("complete_within_limits");
  });

  it("reports parser gaps and finding truncation instead of claiming completeness", () => {
    const malformed = inspection("function broken( {");
    const failed = analyzeCapturedWebBundle(malformed, input());
    expect(failed.completeness).toMatchObject({
      status: "partial",
      parse_failures: 1,
    });
    expect(failed.unknowns[0]?.dimension).toBe("javascript_ast");

    const bounded = analyzeCapturedWebBundle(
      inspection("fetch('/one'); fetch('/two'); fetch('/three');"),
      input({ analysis_limits: { max_findings: 1 } }),
    );
    expect(bounded.observations.endpoints).toHaveLength(1);
    expect(bounded.completeness).toMatchObject({
      status: "truncated",
      dropped_findings: 2,
    });
  });

  it("propagates source-map truncation into completeness and unknowns", () => {
    const analysis = analyzeCapturedWebBundle(
      inspection("export {};"),
      input(),
      {
        status: "truncated",
        requested: 2,
        processed: 1,
        dropped: 1,
        dropped_script_keys: [`scr_${"2".repeat(64)}`],
        items: [
          {
            script_key: `scr_${"1".repeat(64)}`,
            declared_url: "https://app.example.test/app.js.map",
            status: "truncated",
            artifact: null,
            original_sources: [],
            original_module_edges: [],
            mappings: [],
            limitation: "Source-map response exceeded the byte budget.",
          },
        ],
      },
    );

    expect(analysis.completeness.status).toBe("truncated");
    expect(analysis.unknowns).toContainEqual({
      dimension: "source_maps",
      reason: "Source-map evidence was truncated by approved limits",
      affected_script_keys: [`scr_${"1".repeat(64)}`, `scr_${"2".repeat(64)}`],
    });
  });

  it("rejects inconsistent source-map coverage counts", () => {
    const result = analyzeCapturedWebBundle(inspection("export {};"), input());
    expect(
      webBundleAnalysisSchema.safeParse({
        ...result,
        observations: {
          ...result.observations,
          source_maps: {
            ...result.observations.source_maps,
            requested: 1,
          },
        },
      }).success,
    ).toBe(false);
  });
});

const input = (overrides: Record<string, unknown> = {}) =>
  analyzeWebBundleInputSchema.parse({
    ...inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: [origin],
      target_id: "page-1",
      approved: true,
      include_script_sources: true,
    }),
    source_capture_approved: true,
    ...overrides,
  });

const inspection = (source: string) =>
  webPageInspectionSchema.parse({
    schema_version: 2,
    browser: {
      product: "Fake Chrome",
      protocol_version: "1.3",
      revision: "1",
      user_agent: "fake",
      js_version: "1",
    },
    target: {
      target_id: "page-1",
      type: "page",
      title: "App",
      url: `${origin}/app`,
      origin,
      attached: false,
    },
    capture_window: {
      started_at: "2026-07-14T00:00:00.000Z",
      ended_at: "2026-07-14T00:00:01.000Z",
      observation_ms: 1_000,
    },
    completeness: {
      status: "attach_limited",
      conditions: ["attach_limited"],
      policy_filtered_sections: [],
      attach_limited_sections: ["network_requests"],
      truncated_sections: [],
      unavailable_sections: [],
      excluded: [],
      dropped_events: {
        scripts: 0,
        network_requests: 0,
        console_events: 0,
        websocket_connections: 0,
        websocket_frames: 0,
        webmcp_tools: 0,
        timeline_events: 0,
        total: 0,
      },
    },
    frames: [],
    dom: { total_nodes: 0, nodes: [] },
    accessibility: {
      total_nodes: 0,
      text_capture: {
        status: "not_approved",
        retained_bytes: 0,
        excluded_fields: 0,
        truncated_fields: 0,
      },
      nodes: [],
    },
    scripts: {
      total: 1,
      items: [
        {
          script_key: `scr_${"1".repeat(64)}`,
          url: `${origin}/assets/app.js`,
          origin,
          cdp_hash: "hash",
          length: Buffer.byteLength(source),
          is_module: true,
          language: "JavaScript",
          source_map_url: null,
          resource_reconciliation: {
            status: "unmatched",
            reason: "no_exact_sanitized_url",
          },
          source: {
            included: true,
            artifact: createWebTextArtifact(source, "text/javascript"),
          },
        },
      ],
    },
    resources: [],
    network: {
      requests: [],
      websocket_events: [],
      coverage_started_at: "2026-07-14T00:00:00.000Z",
      prior_activity_available: false,
    },
    console: {
      events: [],
      coverage_started_at: "2026-07-14T00:00:00.000Z",
      prior_activity_available: false,
    },
    workers: [],
    metadata: {
      responses: [],
      dom_urls: [],
      agent_hints: [],
      excluded_dom_urls: 0,
      headers_allowlisted: true,
    },
    storage: {
      origin,
      usage_bytes: null,
      quota_bytes: null,
      local_storage_keys: [],
      session_storage_keys: [],
      indexed_db_names: [],
      cache_names: [],
      values_redacted: true,
    },
    limitations: [],
  });
