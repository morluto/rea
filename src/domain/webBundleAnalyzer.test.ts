import { describe, expect, it } from "vitest";

import { webPageInspectionSchema } from "./browserObservation.js";
import { analyzeCapturedWebBundle } from "./webBundleAnalyzer.js";
import { webBundleAnalysisSchema } from "./webBundleAnalysis.js";
import { createWebTextArtifact } from "./webContentArtifact.js";

const origin = "https://app.example.test";

describe("web bundle analyzer", () => {
  it("extracts graph, route, endpoint, vendor, and WebMCP evidence", () => {
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
    const result = analyzeCapturedWebBundle(inspection(source));

    expect(result.observations.chunks.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "static_import",
          specifier: "./chunk.js?token=secret",
          resolved_url: `${origin}/assets/chunk.js?token=secret`,
        }),
        expect.objectContaining({
          kind: "dynamic_import",
          specifier: "./lazy.js",
        }),
      ]),
    );
    expect(result.observations.routes).toEqual([
      expect.objectContaining({ value: "/users/:id?token=secret" }),
    ]);
    expect(result.observations.endpoints).toEqual([
      expect.objectContaining({
        value: "/api/users?authorization=secret",
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
    expect(JSON.stringify(result)).toContain("authorization=secret");
    expect(result.completeness.status).toBe("complete");
  });

  it("reports parser gaps without imposing a finding cap", () => {
    const malformed = inspection("function broken( {");
    const failed = analyzeCapturedWebBundle(malformed);
    expect(failed.completeness).toMatchObject({
      status: "partial",
      parse_failures: 1,
    });
    expect(failed.unknowns[0]?.dimension).toBe("javascript_ast");

    const analyzed = analyzeCapturedWebBundle(
      inspection("fetch('/one'); fetch('/two'); fetch('/three');"),
    );
    expect(analyzed.observations.endpoints).toHaveLength(3);
    expect(analyzed.completeness.status).toBe("complete");
  });

  it("analyzes AST nodes after the former fixed node ceiling", () => {
    const source = `${";".repeat(250_001)}fetch('/last');`;
    const result = analyzeCapturedWebBundle(inspection(source));

    expect(result.observations.endpoints).toContainEqual(
      expect.objectContaining({ value: "/last" }),
    );
    expect(result.completeness.visited_ast_nodes).toBeGreaterThan(250_000);
    expect(result.completeness.status).toBe("complete");
  });

  it("retains complete long chunk and WebMCP declaration text", () => {
    const specifier = `./${"chunk".repeat(1_000)}.js`;
    const name = "tool".repeat(100);
    const description = "untrusted declaration ".repeat(150);
    const propertyName = "property".repeat(100);
    const result = analyzeCapturedWebBundle(
      inspection(`
        import "${specifier}";
        document.modelContext.registerTool({
          name: "${name}",
          description: "${description}",
          inputSchema: { properties: { "${propertyName}": { type: "string" } } }
        });
      `),
    );

    expect(result.observations.chunks.edges[0]?.specifier).toBe(specifier);
    expect(result.observations.webmcp_declarations[0]).toMatchObject({
      name,
      description,
      schema_property_names: [propertyName],
      trust: "page-declared-untrusted",
    });
  });

  it("reports unavailable source maps as partial without dropping requested maps", () => {
    const analysis = analyzeCapturedWebBundle(inspection("export {};"), {
      status: "unavailable",
      requested: 1,
      processed: 1,
      items: [
        {
          script_key: `scr_${"1".repeat(64)}`,
          declared_url: "https://app.example.test/app.js.map",
          status: "fetch_failed",
          artifact: null,
          original_sources: [],
          original_module_edges: [],
          mappings: [],
          limitation: "Source-map fetch failed.",
        },
      ],
    });

    expect(analysis.completeness.status).toBe("partial");
    expect(analysis.unknowns).toContainEqual({
      dimension: "source_maps",
      reason:
        "One or more requested source maps were unavailable or incomplete",
      affected_script_keys: [`scr_${"1".repeat(64)}`],
    });
  });

  it("rejects inconsistent source-map coverage counts", () => {
    const result = analyzeCapturedWebBundle(inspection("export {};"));
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

describe("web bundle artifact metadata", () => {
  it("preserves long provider media types in artifact summaries", () => {
    const result = analyzeCapturedWebBundle(inspection("export {};"));
    const mediaType = `application/${"x".repeat(300)}`;
    const artifact = result.capture.source_artifacts[0] ?? {
      sha256: "0".repeat(64),
      bytes: 0,
      media_type: "application/javascript",
      charset: "utf-8" as const,
      text_available: true as const,
    };

    expect(
      webBundleAnalysisSchema.parse({
        ...result,
        capture: {
          ...result.capture,
          source_artifacts: [{ ...artifact, media_type: mediaType }],
        },
      }).capture.source_artifacts[0]?.media_type,
    ).toBe(mediaType);
  });
});

const inspection = (source: string) =>
  webPageInspectionSchema.parse({
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

it("retains each literal importScripts argument in source order", () => {
  const result = analyzeCapturedWebBundle(
    inspection(
      'importScripts("first.js", dynamicValue, "second.js", "first.js");',
    ),
  );
  expect(
    result.observations.chunks.edges
      .filter(({ kind }) => kind === "worker_import")
      .map(({ specifier }) => specifier),
  ).toEqual(["first.js", "second.js"]);
});
