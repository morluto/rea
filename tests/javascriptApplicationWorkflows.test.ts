import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeJavaScriptApplication } from "../src/application/JavaScriptApplicationService.js";
import { compareApplicationVersionsEvidence } from "../src/application/JavaScriptApplicationWorkflowService.js";
import { createEvidence } from "../src/domain/evidence.js";
import { applicationVersionComparisonResultSchema } from "../src/domain/javascriptApplicationVersionComparisonSchemas.js";
import { compareJavaScriptApplicationVersions } from "../src/domain/javascriptApplicationVersionComparison.js";
import { createJavaScriptApplicationGraph } from "../src/domain/javascriptApplicationGraph.js";
import { traceApplicationFeature } from "../src/domain/javascriptFeatureTrace.js";
import { applicationFeatureTraceResultSchema } from "../src/domain/javascriptFeatureTraceSchemas.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  buildSyntheticJavaScriptApplicationGraph,
} from "./fixtures/javascriptApplicationGraph.js";
import { writeVersionedJavaScriptApplicationFixtures } from "./fixtures/javascriptArtifactApplication.js";
import { permissionAuthorityForRoot } from "./fixtures/permissionAuthority.js";

describe("JavaScript application workflows", () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("traces a contextBridge API through IPC into linked native evidence", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const nativeEvidence = createEvidence(
      {
        path: "/tmp/synthetic.node",
        sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
        format: "elf",
        architecture: "x86_64",
      },
      { id: "ghidra", name: "Ghidra", version: "fixture" },
      {
        operation: "analyze_function",
        parameters: { address: "openProject" },
        result: { name: "openProject", address: "0x1000" },
        limitations: ["Synthetic native provider observation."],
      },
    );

    const result = traceApplicationFeature({
      sourceEvidenceId: `ev_${"a".repeat(64)}`,
      graph,
      nativeEvidence: [nativeEvidence],
      seed: {
        kind: "api",
        value: "desktopApi",
        match: "exact",
        case_sensitive: false,
      },
      direction: "outgoing",
      limits: traceLimits(),
    });

    expect(() =>
      applicationFeatureTraceResultSchema.parse(result),
    ).not.toThrow();
    expect(result.summary).toMatchObject({
      matched_seeds: 1,
      native_handoffs: 1,
    });
    expect(result.native_handoffs).toContainEqual(
      expect.objectContaining({
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
        status: "evidence-linked",
        evidence_ids: [nativeEvidence.evidence_id],
        requested_exports: expect.arrayContaining(["openProject"]),
      }),
    );
    expect(result.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ end_kind: "native-export" }),
      ]),
    );
    expect(
      result.graph?.edges.some(
        ({ evidence }) =>
          evidence.authority === "static-relationship-inference" &&
          evidence.state === "inferred",
      ),
    ).toBe(true);
  });

  it("keeps no-match and bounded frontiers explicit", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const noMatch = traceApplicationFeature({
      sourceEvidenceId: `ev_${"a".repeat(64)}`,
      graph,
      nativeEvidence: [],
      seed: {
        kind: "route",
        value: "/missing",
        match: "exact",
        case_sensitive: false,
      },
      direction: "both",
      limits: traceLimits(),
    });
    expect(noMatch).toMatchObject({
      graph: null,
      coverage: { status: "no-match" },
      summary: { matched_seeds: 0 },
    });

    const bounded = traceApplicationFeature({
      sourceEvidenceId: `ev_${"a".repeat(64)}`,
      graph,
      nativeEvidence: [],
      seed: {
        kind: "api",
        value: "desktopApi",
        match: "exact",
        case_sensitive: false,
      },
      direction: "outgoing",
      limits: { ...traceLimits(), max_depth: 1 },
    });
    expect(bounded.coverage).toMatchObject({ status: "truncated" });
    expect(bounded.coverage.omitted_nodes).toBeGreaterThan(0);
    expect(bounded.summary.native_handoffs).toBe(0);
  });

  it("matches rechunked modules by exact source and minified modules by structural fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-application-versions-"));
    temporary.push(root);
    const fixtures = await writeVersionedJavaScriptApplicationFixtures(root);
    const [left, right] = await Promise.all([
      analyzeFixture(fixtures.left, true),
      analyzeFixture(fixtures.right, true),
    ]);
    const compared = compareApplicationVersionsEvidence({ left, right });
    if (!compared.ok) throw compared.error;
    const result = applicationVersionComparisonResultSchema.parse(
      compared.value.normalized_result,
    );
    const modules = result.items.filter(
      ({ node_kind: kind }) => kind === "javascript-module",
    );

    expect(modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          match: expect.objectContaining({
            status: "matched",
            basis: "exact-module-source-digest",
            confidence: "exact",
          }),
        }),
        expect.objectContaining({
          status: "changed",
          match: expect.objectContaining({
            status: "matched",
            basis: "structural-fingerprint",
            confidence: "medium",
          }),
        }),
      ]),
    );
    expect(result.matching.ambiguous).toBeGreaterThanOrEqual(4);
    expect(modules.filter(({ match }) => match.status === "ambiguous")).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "unknown" })]),
    );
    expect(result.summary.added).toBeGreaterThan(0);
    expect(result.summary.removed).toBeGreaterThan(0);
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "changed_from",
          evidence: expect.objectContaining({
            authority: "cross-version-comparison",
            state: "inferred",
          }),
        }),
      ]),
    );
    expect(result.limitations.join(" ")).toMatch(
      /module ordinals|fuzzy pairing/u,
    );
  });

  it("pairs source-map originals without promoting the match to exact", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-source-map-versions-"));
    temporary.push(root);
    const fixtures = await writeVersionedJavaScriptApplicationFixtures(root);
    const [left, right] = await Promise.all([
      analyzeFixture(fixtures.left, true),
      analyzeFixture(fixtures.right, true),
    ]);
    const compared = compareApplicationVersionsEvidence({ left, right });
    if (!compared.ok) throw compared.error;
    const result = applicationVersionComparisonResultSchema.parse(
      compared.value.normalized_result,
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        node_kind: "source-module",
        status: "changed",
        match: expect.objectContaining({
          basis: "source-map-identity",
          confidence: "high",
        }),
      }),
    );
  });

  it("keeps incomplete one-sided absence unknown and reports output truncation", () => {
    const complete = buildSyntheticJavaScriptApplicationGraph();
    const rootNode = complete.nodes.find(({ node_id: id }) =>
      complete.root_node_ids.includes(id),
    );
    if (rootNode === undefined) throw new Error("Synthetic graph root missing");
    const partial = createJavaScriptApplicationGraph({
      schema: "JavaScriptApplicationGraph",
      schema_version: 1,
      root_node_ids: [rootNode.node_id],
      nodes: [rootNode],
      edges: [],
      coverage: {
        status: "partial",
        truncated: true,
        omitted_count: complete.nodes.length - 1,
        limits: [{ name: "fixture_nodes", value: 1, unit: "items" }],
      },
      limitations: ["Synthetic partial graph."],
    });
    const input = {
      left: {
        evidenceId: `ev_${"a".repeat(64)}`,
        rootArtifactSha256: APPLICATION_GRAPH_DIGESTS.package,
        graph: complete,
      },
      right: {
        evidenceId: `ev_${"b".repeat(64)}`,
        rootArtifactSha256: APPLICATION_GRAPH_DIGESTS.package,
        graph: partial,
      },
      leftNativeEvidence: [],
      rightNativeEvidence: [],
      limits: {
        max_comparison_items: 1,
        max_candidate_nodes: 1,
        max_graph_nodes: 20,
        max_graph_edges: 20,
      },
    };

    const first = compareJavaScriptApplicationVersions(input);
    const second = compareJavaScriptApplicationVersions(input);
    expect(first.comparison_id).toBe(second.comparison_id);
    expect(first.coverage).toMatchObject({
      status: "truncated",
      right_graph_status: "partial",
    });
    expect(first.coverage.omitted_comparison_items).toBeGreaterThan(0);
    expect(first.summary.removed).toBe(0);
    expect(first.summary.unknown).toBeGreaterThan(0);
  });
});

const traceLimits = () => ({
  max_seed_matches: 25,
  max_depth: 12,
  max_nodes: 2_000,
  max_edges: 4_000,
  max_paths: 100,
});

const analyzeFixture = async (root: string, sourceMaps = false) => {
  const authority = await permissionAuthorityForRoot(
    root,
    ["investigation_input"],
    ["investigation_input"],
  );
  const result = await analyzeJavaScriptApplication(authority, {
    input_path: root,
    approved: true,
    source_map_read_approved: sourceMaps,
  });
  if (!result.ok) throw result.error;
  return result.value;
};
