import { jsonValueSchema } from "../domain/jsonValue.js";
import { describe, expect, it } from "vitest";

import { createBrowserEvidence } from "./BrowserEvidence.js";
import { listBrowserTargetsInputSchema } from "../domain/browserObservation.js";
import { browserTargetListSchema } from "../domain/browserObservationSchemas.js";
import {
  analyzeWebBundleInputSchema,
  webBundleAnalysisSchema,
} from "../domain/webBundleAnalysis.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

const result = webBundleAnalysisSchema.parse({
  capture: {
    target_url: "https://app.example.test/dashboard?token=redacted",
    target_origin: "https://app.example.test",
    scripts_observed: 0,
    scripts_analyzed: 0,
    source_artifacts: [],
  },
  observations: {
    chunks: { nodes: [], edges: [] },
    routes: [],
    endpoints: [],
    webmcp_declarations: [],
    source_maps: {
      status: "not_requested",
      requested: 0,
      processed: 0,
      items: [],
    },
  },
  inferences: [],
  unknowns: [],
  completeness: {
    status: "complete",
    parsed_scripts: 0,
    parse_failures: 0,
    visited_ast_nodes: 0,
  },
  limitations: [],
});

const bundleInput = {
  cdp_endpoint: "http://127.0.0.1:9222",
  target_id: "page-1",
  observation_ms: 0,
};
const input = (allowedOrigins: string[]) =>
  analyzeWebBundleInputSchema.parse({
    ...bundleInput,
    allowed_origins: allowedOrigins,
  });

const deadlines = {
  command_timeout_ms: 1_500,
  discovery_timeout_ms: 15_000,
  source_map_fetch_timeout_ms: 1_750,
};

describe("web bundle Evidence scope", () => {
  it("records the captured target origin and leaves implicit deadlines omitted", () => {
    const evidence = createBrowserEvidence(
      "analyze_web_bundle",
      input([]),
      { source: jsonValueSchema.parse(result), facts: result },
      provider,
    );

    expect(evidence.parameters.allowed_origins).toEqual([
      "https://app.example.test",
    ]);
    for (const deadline of Object.keys(deadlines))
      expect(evidence.parameters).not.toHaveProperty(deadline);
  });

  it("preserves the caller's explicit origin scope and independent deadlines", () => {
    const evidence = createBrowserEvidence(
      "analyze_web_bundle",
      analyzeWebBundleInputSchema.parse({
        ...bundleInput,
        allowed_origins: ["https://explicit.example.test"],
        fetch_source_maps: true,
        ...deadlines,
      }),
      { source: jsonValueSchema.parse(result), facts: result },
      provider,
    );

    expect(evidence.parameters).toMatchObject({
      allowed_origins: ["https://explicit.example.test"],
      ...deadlines,
    });
  });

  it("does not infer an origin from a URL without one", () => {
    const observed = webBundleAnalysisSchema.parse({
      ...result,
      capture: {
        ...result.capture,
        target_url: "file:///tmp/app.html",
        target_origin: null,
      },
    });
    const evidence = createBrowserEvidence(
      "analyze_web_bundle",
      input([]),
      { source: jsonValueSchema.parse(observed), facts: observed },
      provider,
    );

    expect(evidence.parameters.allowed_origins).toEqual([]);
  });

  it("does not infer a non-HTTP origin from a bundle URL", () => {
    const observed = webBundleAnalysisSchema.parse({
      ...result,
      capture: {
        ...result.capture,
        target_url: "ftp://host/app",
        target_origin: null,
      },
    });
    const evidence = createBrowserEvidence(
      "analyze_web_bundle",
      input([]),
      { source: jsonValueSchema.parse(observed), facts: observed },
      provider,
    );

    expect(evidence.parameters.allowed_origins).toEqual([]);
  });
});

it.each([undefined, {}, { decoded_records: 1024 }])(
  "preserves the selected source-map admission policy %j without resolving defaults",
  (selection) => {
    const selected = analyzeWebBundleInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
      fetch_source_maps: true,
      ...(selection === undefined ? {} : { source_map_limits: selection }),
    });
    const evidence = createBrowserEvidence(
      "analyze_web_bundle",
      selected,
      { source: jsonValueSchema.parse(result), facts: result },
      provider,
    );
    if (selection === undefined)
      expect(evidence.parameters).not.toHaveProperty("source_map_limits");
    else expect(evidence.parameters.source_map_limits).toEqual(selection);
  },
);

const targetList = browserTargetListSchema.parse({
  browser: {
    product: "fixture",
    protocol_version: "1.3",
    revision: "fake-revision",
    user_agent: "FakeChrome",
    js_version: "13.0",
  },
  targets: [],
  excluded: { disallowed_origin: 0, unsupported_url: 0, non_page: 0 },
  limitations: [],
});

it("records only the caller-selected discovery deadline on target listing", () => {
  const cdp_endpoint = "ws://127.0.0.1:9222/devtools/browser/fake";
  const observation = {
    source: jsonValueSchema.parse(targetList),
    facts: targetList,
  };
  const explicit = createBrowserEvidence(
    "list_browser_targets",
    listBrowserTargetsInputSchema.parse({
      cdp_endpoint,
      discovery_timeout_ms: 25_000,
    }),
    observation,
    provider,
  );
  expect(explicit.parameters.discovery_timeout_ms).toBe(25_000);
  expect(explicit.parameters).not.toHaveProperty("command_timeout_ms");
  const omitted = createBrowserEvidence(
    "list_browser_targets",
    listBrowserTargetsInputSchema.parse({ cdp_endpoint }),
    observation,
    provider,
  );
  expect(omitted.parameters).not.toHaveProperty("discovery_timeout_ms");
  expect(omitted.parameters).not.toHaveProperty("command_timeout_ms");
});
