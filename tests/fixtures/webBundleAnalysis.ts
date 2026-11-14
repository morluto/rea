import type { WebBundleAnalysis } from "../../src/domain/webBundleAnalysis.js";

export const sampleWebBundleAnalysis = (): WebBundleAnalysis => ({
  capture: {
    target_url: "https://example.test/app",
    target_origin: "https://example.test",
    scripts_observed: 3,
    scripts_analyzed: 2,
    source_artifacts: [],
  },
  observations: {
    chunks: {
      nodes: [
        {
          script_key: "app.js",
          url: "https://example.test/app.js",
          artifact_sha256: "a".repeat(64),
          bytes: 1200,
        },
        {
          script_key: "vendor.js",
          url: "https://example.test/vendor.js",
          artifact_sha256: "b".repeat(64),
          bytes: 4500,
        },
      ],
      edges: [],
    },
    routes: [],
    endpoints: [
      {
        value: "/api/users",
        mechanism: "call:fetch",
        location: { script_key: "app.js", line: 10, column: 2 },
      },
      {
        value: "/api/users",
        mechanism: "call:fetch",
        location: { script_key: "vendor.js", line: 42, column: 8 },
      },
      {
        value: "/api/orders",
        mechanism: "call:sendBeacon",
        location: { script_key: "app.js", line: 85, column: 4 },
      },
    ],
    webmcp_declarations: [],
    source_maps: {
      status: "not_requested",
      requested: 0,
      processed: 0,
      items: [],
    },
  },
  inferences: [
    {
      kind: "endpoint_candidate",
      value: "/api/dynamic-user",
      confidence: "low",
      basis: [
        {
          script_key: "app.js",
          artifact_sha256: "a".repeat(64),
          line: 25,
          column: 4,
          detector: "call:client.get:unverified-network-receiver",
        },
      ],
    },
    {
      kind: "vendor_fingerprint",
      value: "React",
      confidence: "high",
      basis: [
        {
          script_key: "vendor.js",
          artifact_sha256: "b".repeat(64),
          line: 1,
          column: 0,
          detector: "vendor:react",
        },
      ],
    },
  ],
  unknowns: [
    {
      dimension: "network",
      reason: "Unverified client receiver",
      affected_script_keys: ["app.js"],
    },
  ],
  completeness: {
    status: "partial",
    parsed_scripts: 2,
    parse_failures: 1,
    visited_ast_nodes: 150,
  },
  limitations: ["Script evaluation was omitted"],
});
