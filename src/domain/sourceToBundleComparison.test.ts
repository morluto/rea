import { describe, expect, it } from "vitest";

import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "./javascriptApplicationGraph.js";
import { createHistoricalSourceGraph } from "./referenceSourceGraph.js";
import { compareSourceToBundle } from "./sourceToBundleComparison.js";
import { sourceToBundleComparisonResultSchema } from "./sourceToBundleComparisonSchemas.js";
import { artifactEvidence } from "./javascriptApplicationGraph.fixture.js";

const HASH = {
  artifact: "1".repeat(64),
  unchanged: "2".repeat(64),
  modified: "3".repeat(64),
  removed: "4".repeat(64),
  split: "5".repeat(64),
  merged: "6".repeat(64),
  duplicated: "7".repeat(64),
} as const;
const EVIDENCE_ID = `ev_${"a".repeat(64)}`;

describe("historical source to bundle comparison", () => {
  it("classifies exact, changed, absent, split, and merged mappings stably", () => {
    const reference = historicalGraph("complete");
    const graph = applicationGraph("complete");
    const input = {
      reference,
      application: {
        evidenceId: EVIDENCE_ID,
        rootArtifactSha256: HASH.artifact,
        graph,
      },
      limits: limits(),
    };

    const first = compareSourceToBundle(input);
    const second = compareSourceToBundle(input);

    expect(first).toEqual(second);
    expect(() =>
      sourceToBundleComparisonResultSchema.parse(first),
    ).not.toThrow();
    expect(first.summary).toEqual({
      unchanged: 1,
      modified: 0,
      removed: 1,
      split: 1,
      merged: 2,
      duplicated: 1,
      unknown: 1,
    });
    expect(item(first, "src/unchanged.ts")).toMatchObject({
      status: "unchanged",
      confidence: "exact",
      candidates: [
        expect.objectContaining({
          signals: expect.arrayContaining([
            expect.objectContaining({
              kind: "exact-source-digest",
              weight: 100,
            }),
          ]),
        }),
      ],
    });
    expect(item(first, "src/modified.ts")).toMatchObject({
      status: "unknown",
      confidence: "unknown",
      candidates: [
        expect.objectContaining({
          signals: expect.arrayContaining([
            expect.objectContaining({ kind: "current-path-exact", weight: 60 }),
          ]),
        }),
      ],
    });
    expect(item(first, "src/removed.ts")).toMatchObject({
      status: "removed",
      current_node_ids: [],
    });
    expect(item(first, "src/split.ts")).toMatchObject({
      status: "split",
      confidence: "medium",
      current_node_ids: [expect.any(String), expect.any(String)],
    });
    expect(item(first, "src/merged-a.ts").status).toBe("merged");
    expect(item(first, "src/merged-b.ts").status).toBe("merged");
    expect(item(first, "src/duplicated.ts")).toMatchObject({
      status: "duplicated",
      confidence: "exact",
      current_node_ids: [expect.any(String), expect.any(String)],
    });
    expect(first.coverage.status).toBe("complete-within-inputs");
  });

  it("keeps absence unknown when either inventory is incomplete", () => {
    const reference = historicalGraph("partial", ["src/removed.ts"]);
    const graph = applicationGraph("partial");
    const result = compareSourceToBundle({
      reference,
      application: {
        evidenceId: EVIDENCE_ID,
        rootArtifactSha256: HASH.artifact,
        graph,
      },
      limits: limits(),
    });

    expect(result.summary).toMatchObject({ removed: 0, unknown: 1 });
    expect(result.items[0]).toMatchObject({
      source_path: "src/removed.ts",
      status: "unknown",
      confidence: "unknown",
    });
    expect(result.coverage.status).toBe("partial");
  });

  it("keeps exact mappings unknown when candidate output is truncated", () => {
    const result = compareSourceToBundle({
      reference: historicalGraph("complete"),
      application: {
        evidenceId: EVIDENCE_ID,
        rootArtifactSha256: HASH.artifact,
        graph: applicationGraph("complete"),
      },
      limits: { ...limits(), max_candidate_nodes: 1 },
    });

    expect(item(result, "src/duplicated.ts").status).toBe("unknown");
    expect(
      item(result, "src/duplicated.ts").omitted_candidates,
    ).toBeGreaterThan(0);
  });

  it("reports the candidate frontier instead of deciding past a limit", () => {
    const result = compareSourceToBundle({
      reference: historicalGraph("complete", ["src/split.ts"]),
      application: {
        evidenceId: EVIDENCE_ID,
        rootArtifactSha256: HASH.artifact,
        graph: applicationGraph("complete"),
      },
      limits: { ...limits(), max_candidate_evaluations: 1 },
    });

    expect(result.items[0]).toMatchObject({
      status: "unknown",
      confidence: "unknown",
      omitted_candidates: 1,
    });
    expect(result.coverage).toMatchObject({
      status: "truncated",
      candidate_evaluations: 1,
      omitted_candidate_evaluations: 1,
    });
  });
});

const historicalGraph = (
  inventoryState: "complete" | "partial",
  paths = [
    "src/duplicated.ts",
    "src/merged-a.ts",
    "src/merged-b.ts",
    "src/modified.ts",
    "src/removed.ts",
    "src/split.ts",
    "src/unchanged.ts",
  ],
) =>
  createHistoricalSourceGraph({
    schema: "HistoricalSourceGraph/v1",
    authority: "historical-reference",
    root_alias: "$REFERENCE_ROOT",
    inventory_state: inventoryState,
    entries: [
      {
        path: "src",
        kind: "directory",
        classifications: ["source"],
        tree_state: inventoryState === "complete" ? "enumerated" : "partial",
        limitations:
          inventoryState === "complete"
            ? []
            : ["Fixture inventory is partial."],
      },
      ...paths.map((path) => ({
        path,
        kind: "file" as const,
        sha256: sourceDigest(path),
        size: 10,
        language: "TypeScript",
        classifications: ["source"] as const,
        content_state: "hashed" as const,
        limitations: [],
      })),
    ],
    relationships: [],
    parse_failures: [],
    exclusions: [],
    languages: ["TypeScript"],
    manifests: [],
    vcs: { kind: "none", head: null, dirty: null },
    provenance: {
      importer: "rea-test",
      importer_version: "1",
      caller: "source-to-bundle-test",
    },
    limitations:
      inventoryState === "complete" ? [] : ["Fixture inventory is partial."],
  });

const applicationGraph = (coverage: "complete" | "partial") => {
  const nodes = [
    moduleNode("duplicated-a", {
      path: "bundle-a.js",
      source_sha256: HASH.duplicated,
    }),
    moduleNode("duplicated-b", {
      path: "bundle-b.js",
      source_sha256: HASH.duplicated,
    }),
    moduleNode("unchanged", {
      path: "bundle.js",
      source_sha256: HASH.unchanged,
    }),
    createJavaScriptApplicationNode({
      kind: "javascript-asset",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: HASH.artifact,
        path: "src/modified.ts",
      },
      observations: [
        {
          label: "src/modified.ts",
          properties: { path: "src/modified.ts" },
          evidence: artifactEvidence(HASH.artifact, "src/modified.ts"),
        },
      ],
    }),
    moduleNode("split-a", { path: "bundle-a/src/split.ts" }),
    moduleNode("split-b", { path: "bundle-b/src/split.ts" }),
    moduleNode("merged", {
      path: "bundle.js",
      source_sha256: HASH.merged,
    }),
  ];
  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    schema_version: 1,
    root_node_ids: nodes.map(({ node_id: nodeId }) => nodeId),
    nodes,
    edges: [],
    coverage:
      coverage === "complete"
        ? {
            status: "complete",
            truncated: false,
            omitted_count: 0,
            limits: [],
          }
        : {
            status: "partial",
            truncated: true,
            omitted_count: 1,
            limits: [{ name: "fixture", value: 5, unit: "items" }],
          },
    limitations:
      coverage === "complete" ? [] : ["Fixture graph coverage is partial."],
  });
};

const moduleNode = (key: string, properties: Record<string, string>) =>
  createJavaScriptApplicationNode({
    kind: "javascript-module",
    identity: {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: HASH.artifact,
      namespace: "test",
      key,
    },
    observations: [
      {
        label: key,
        properties,
        evidence: artifactEvidence(HASH.artifact, "bundle.js"),
      },
    ],
  });

const sourceDigest = (path: string): string => {
  if (path.includes("duplicated")) return HASH.duplicated;
  if (path.includes("merged")) return HASH.merged;
  if (path.includes("modified")) return HASH.modified;
  if (path.includes("removed")) return HASH.removed;
  if (path.includes("split")) return HASH.split;
  return HASH.unchanged;
};

const limits = () => ({
  max_source_files: 100,
  max_application_nodes: 100,
  max_candidate_nodes: 100,
  max_candidate_evaluations: 10_000,
});

const item = (
  result: ReturnType<typeof compareSourceToBundle>,
  sourcePath: string,
) => {
  const value = result.items.find(
    ({ source_path: path }) => path === sourcePath,
  );
  if (value === undefined) throw new TypeError(`Missing item: ${sourcePath}`);
  return value;
};
