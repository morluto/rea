import { expect, it } from "vitest";

import { compareJavaScriptApplicationVersions } from "../../../../src/domain/javascript/javascriptApplicationVersionComparison.js";
import { traceApplicationFeature } from "../../../../src/domain/javascript/javascriptFeatureTrace.js";
import { matchJavaScriptApplicationVersions } from "../../../../src/domain/javascript/javascriptApplicationVersionKeys.js";
import { findApplicationFeatureSeeds } from "../../../../src/domain/javascript/javascriptFeatureSeed.js";
import { projectJavaScriptApplicationView } from "../../../../src/domain/analysisView/javascriptApplicationView.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  reconstructJavaScriptFixture,
  writeFixtureFiles,
} from "../../../support/javascriptApplicationFixture.js";

it("retains a candidate when table data contains harmless parameter-named keys", async () => {
  const root = await createTestTempDirectory("rea-vite-property-keys-");
  await writeFixtureFiles(root, {
    "main.js": `const __vite__mapDeps = (i, m = __vite__mapDeps, d = m.f || (m.f = ["./lazy.js", {i: 0, arguments: 1}])) => i.map(n => d[n]); __vite__mapDeps([0]);`,
    "lazy.js": "export const lazy = true;",
  });
  const { graph } = await reconstructJavaScriptFixture(root);
  const candidates = graph.nodes.flatMap(({ observations }) =>
    observations.filter(
      ({ properties }) => properties.vite_table_candidate === true,
    ),
  );
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.properties).toMatchObject({
    specifier: "./lazy.js",
    candidate_path: "lazy.js",
    resolution_status: "unavailable",
  });
});

it("keeps Vite table candidates uncertain while direct imports still resolve", async () => {
  const root = await createTestTempDirectory("rea-vite-table-candidate-");
  await writeFixtureFiles(root, {
    "assets/main.js": `
      const __vite__mapDeps = (i, m = __vite__mapDeps,
        d = (m.f || (m.f = ["./lazy.js"]))) => i.map(i => d[i]);
      const helper = deps => deps.map(dep => "https://elsewhere.test/other.js");
      helper(__vite__mapDeps([0]));
      import("./lazy.js");
      import("vite-output:assets/lazy.js");
    `,
    "assets/lazy.js": "export const lazy = true;",
  });
  const result = await reconstructJavaScriptFixture(root);
  expect(result.graph.coverage.status).toBe("partial");
  const comparison = compareJavaScriptApplicationVersions({
    left: {
      evidenceId: `ev_${"a".repeat(64)}`,
      rootArtifactSha256: result.root_artifact_sha256,
      graph: result.graph,
    },
    right: {
      evidenceId: `ev_${"b".repeat(64)}`,
      rootArtifactSha256: result.root_artifact_sha256,
      graph: result.graph,
    },
    leftNativeEvidence: [],
    rightNativeEvidence: [],
  });
  expect(
    comparison.items
      .filter((item) => item.node_kind === "javascript-asset")
      .map((item) => item.status),
  ).toEqual(expect.arrayContaining(["unknown"]));
  expect(
    comparison.items.filter(
      (item) =>
        item.node_kind === "javascript-asset" && item.status === "unchanged",
    ),
  ).toHaveLength(0);
  const edges = result.graph.edges.filter(
    (edge) =>
      edge.relation === "imports" && edge.properties.specifier === "./lazy.js",
  );
  expect(edges).toHaveLength(1);
  expect(edges[0]?.properties).toMatchObject({
    resolution_status: "resolved",
    resolved_path: "assets/lazy.js",
  });
  expect(result.graph.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          specifier: "vite-output:assets/lazy.js",
          resolution_status: "external",
          resolved_path: null,
        }),
      }),
    ]),
  );
  const candidates = result.graph.nodes.filter(
    (node) =>
      node.kind === "unknown" &&
      node.observations.some((o) => o.properties.vite_table_candidate === true),
  );
  expect(candidates).toHaveLength(1);
  expect(
    result.graph.nodes.filter(
      (node) =>
        node.kind === "javascript-module" &&
        node.observations.some(
          (o) =>
            o.properties.specifier === "./lazy.js" &&
            o.properties.resolution === "unresolved",
        ),
    ),
  ).toHaveLength(0);
  expect(candidates[0]?.observations[0]?.properties).toMatchObject({
    specifier: "./lazy.js",
    resolution_status: "unavailable",
    candidate_path: "assets/lazy.js",
  });
});

it("keeps byte-identical source occurrences and incoming traces separate", async () => {
  const root = await createTestTempDirectory("rea-vite-candidate-occurrences-");
  const source = `
    const __vite__mapDeps = (i, m = __vite__mapDeps,
      d = m.f || (m.f = ["./lazy.js"])) => i.map(i => d[i]);
    __vite__mapDeps([0]);
    new Worker(new URL("./worker.js", import.meta.url));
    import("./missing.js");
    fetch("/api/items");
    fetch("/api/items");
    localStorage.getItem("session");
    localStorage.getItem("session");
    //# sourceMapping${"URL"}=missing.js.map
  `;
  await writeFixtureFiles(root, {
    "left/main.js": source,
    "right/main.js": source,
    "left/lazy.js": "export const lazy = true;",
    "right/lazy.js": "export const lazy = false;",
    "left/worker.js": "leftWorker();",
    "right/worker.js": "rightWorker();",
  });
  const result = await reconstructJavaScriptFixture(root);
  const { graph } = result;
  const candidates = graph.nodes.filter((node) =>
    node.observations.some(
      ({ properties }) => properties.vite_table_candidate === true,
    ),
  );
  expect(candidates).toHaveLength(2);
  expect(
    candidates
      .map((node) => node.observations[0]?.properties.candidate_path)
      .sort(),
  ).toEqual(["left/lazy.js", "right/lazy.js"]);
  expect(graph.nodes.filter(({ kind }) => kind === "worker")).toHaveLength(2);
  expect(
    graph.nodes
      .filter(({ kind }) => kind === "worker")
      .map((node) => node.observations[0]?.properties.resolved_path)
      .sort(),
  ).toEqual(["left/worker.js", "right/worker.js"]);
  expect(graph.nodes.filter(({ kind }) => kind === "endpoint")).toHaveLength(2);
  expect(graph.nodes.filter(({ kind }) => kind === "storage")).toHaveLength(2);
  for (const kind of ["endpoint", "storage"] as const)
    expect(
      graph.nodes
        .filter((node) => node.kind === kind)
        .map((node) => node.observations.length),
    ).toEqual([2, 2]);
  expect(
    graph.nodes.filter(
      (node) =>
        node.kind === "source-map" &&
        node.observations.some(
          ({ properties }) => properties.declared_url === "missing.js.map",
        ),
    ),
  ).toHaveLength(2);
  expect(
    graph.nodes.filter((node) =>
      node.observations.some(
        ({ properties }) =>
          properties.reference_kind === "dynamic-import" &&
          properties.specifier === "./missing.js",
      ),
    ),
  ).toHaveLength(2);
  for (const direction of ["incoming", "both"] as const) {
    const trace = traceApplicationFeature({
      sourceEvidenceId: `ev_${"a".repeat(64)}`,
      graph,
      nativeEvidence: [],
      seed: {
        kind: "string",
        value: "left/lazy.js",
        match: "exact",
        case_sensitive: true,
      },
      direction,
    });
    const paths =
      trace.graph?.nodes.flatMap((node) =>
        node.observations.flatMap(({ properties }) =>
          typeof properties.logical_module_key === "string"
            ? [properties.logical_module_key]
            : [],
        ),
      ) ?? [];
    expect(paths).toContain("left/main.js");
    expect(paths).not.toContain("right/main.js");
    const observedPaths =
      trace.graph?.nodes.flatMap((node) =>
        node.observations.flatMap(({ properties }) =>
          typeof properties.path === "string" ? [properties.path] : [],
        ),
      ) ?? [];
    expect(observedPaths).toContain("left/main.js");
    expect(observedPaths).not.toContain("right/main.js");
  }
  const sourceNode = graph.nodes.find((node) =>
    node.observations.some(
      ({ properties }) => properties.logical_module_key === "left/main.js",
    ),
  );
  expect(sourceNode).toBeDefined();
  const trace = traceApplicationFeature({
    sourceEvidenceId: `ev_${"a".repeat(64)}`,
    graph,
    nativeEvidence: [],
    seed: {
      kind: "node-id",
      value: sourceNode?.node_id ?? "",
      match: "exact",
      case_sensitive: true,
    },
    direction: "both",
  });
  expect(
    trace.graph?.nodes.some((node) =>
      node.observations.some(
        ({ properties }) => properties.logical_module_key === "right/main.js",
      ),
    ),
  ).toBe(false);
  expectOccurrenceAssetCompatibility(result);
});

const expectOccurrenceAssetCompatibility = (
  result: Awaited<ReturnType<typeof reconstructJavaScriptFixture>>,
) => {
  const { graph } = result;
  const sharedAsset = graph.nodes.find(
    (node) =>
      node.kind === "javascript-asset" &&
      node.observations.some(
        ({ properties }) => properties.path === "left/main.js",
      ),
  );
  expect(sharedAsset?.observations).toHaveLength(1);
  const pathTrace = traceApplicationFeature({
    sourceEvidenceId: `ev_${"a".repeat(64)}`,
    graph,
    nativeEvidence: [],
    seed: {
      kind: "string",
      value: "left/main.js",
      match: "exact",
      case_sensitive: true,
    },
    direction: "both",
  });
  expect(
    pathTrace.graph?.nodes.some((node) =>
      node.observations.some(
        ({ properties }) => properties.path === "right/main.js",
      ),
    ),
  ).toBe(false);
  if (sharedAsset?.identity.strategy !== "artifact-local-key")
    throw new Error("Expected occurrence-scoped JavaScript asset");
  const digest = sharedAsset.identity.artifact_sha256;
  const historical = {
    ...sharedAsset,
    node_id: `jag_node_${"b".repeat(64)}`,
    identity: {
      strategy: "content-digest" as const,
      stability: "global-exact" as const,
      sha256: digest,
    },
  };
  expect(
    matchJavaScriptApplicationVersions([historical], [sharedAsset]).pairs[0]
      ?.basis,
  ).toBe("exact-content-digest");
  expect(
    findApplicationFeatureSeeds([historical, sharedAsset], {
      kind: "module",
      value: digest,
      match: "exact",
      case_sensitive: true,
    }),
  ).toHaveLength(2);
  for (const asset of [historical, sharedAsset]) {
    const { electron_summary: summary, ...reconstructed } = result;
    const original = javascriptApplicationAnalysisResultSchema.parse({
      ...reconstructed,
      summary,
    });
    const analysis = {
      ...original,
      graph: { ...original.graph, nodes: [asset] },
    };
    const view = projectJavaScriptApplicationView(
      {
        evidenceId: `ev_${"a".repeat(64)}`,
        operation: "analyze_javascript_application",
        predicateType: "rea.javascript-application-analysis",
        normalizedResult: analysis,
        limitations: [],
      },
      analysis,
      {
        kind: "item",
        collection: "modules",
        selector: { node_id: asset.node_id },
      },
    );
    expect(view).toMatchObject({
      ok: true,
      value: { item: { hashes: expect.arrayContaining([digest]) } },
    });
  }
  const assetTrace = traceApplicationFeature({
    sourceEvidenceId: `ev_${"a".repeat(64)}`,
    graph,
    nativeEvidence: [],
    seed: {
      kind: "node-id",
      value: sharedAsset?.node_id ?? "",
      match: "exact",
      case_sensitive: true,
    },
    direction: "incoming",
  });
  expect(
    assetTrace.graph?.nodes.find(
      ({ node_id }) => node_id === sharedAsset?.node_id,
    )?.observations,
  ).toEqual(sharedAsset?.observations);
};
