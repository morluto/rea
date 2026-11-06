import { expect, it } from "vitest";

import { compareJavaScriptApplicationVersions } from "../../../../src/domain/javascript/javascriptApplicationVersionComparison.js";
import { matchJavaScriptApplicationVersions } from "../../../../src/domain/javascript/javascriptApplicationVersionKeys.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  reconstructJavaScriptFixture,
  writeFixtureFiles,
} from "../../../support/javascriptApplicationFixture.js";

it("matches an unchanged URL-backed source map in its occurrence across versions", async () => {
  const leftRoot = await createTestTempDirectory("rea-url-map-left-");
  const rightRoot = await createTestTempDirectory("rea-url-map-right-");
  const map = JSON.stringify({
    version: 3,
    sourceRoot: "webpack:///",
    sources: ["src/main.ts"],
    sourcesContent: ["export const value = 1"],
    names: [],
    mappings: "AAAA",
  });
  const files = {
    "main.js": `//# sourceMapping${"URL"}=main.js.map`,
    "main.js.map": map,
  };
  await writeFixtureFiles(leftRoot, { ...files, "sibling.js": "left();" });
  await writeFixtureFiles(rightRoot, { ...files, "sibling.js": "right();" });
  const left = await reconstructJavaScriptFixture(leftRoot);
  const right = await reconstructJavaScriptFixture(rightRoot);
  const originals = (graph: typeof left.graph) =>
    graph.nodes.filter(
      ({ identity }) => identity.strategy === "source-map-original",
    );
  const [leftOriginal] = originals(left.graph);
  const [rightOriginal] = originals(right.graph);
  if (leftOriginal === undefined || rightOriginal === undefined)
    throw new Error("Expected URL-backed originals");
  expect(
    leftOriginal.observations[0]?.source_map_reference?.resolution.kind,
  ).toBe("suffix");
  expect(leftOriginal.node_id).not.toBe(rightOriginal.node_id);
  expect(
    matchJavaScriptApplicationVersions([leftOriginal], [rightOriginal]).pairs,
  ).toEqual([
    expect.objectContaining({
      basis: "source-map-identity",
      confidence: "high",
    }),
  ]);
  const comparison = compareJavaScriptApplicationVersions({
    left: {
      evidenceId: `ev_${"a".repeat(64)}`,
      rootArtifactSha256: left.root_artifact_sha256,
      graph: left.graph,
    },
    right: {
      evidenceId: `ev_${"b".repeat(64)}`,
      rootArtifactSha256: right.root_artifact_sha256,
      graph: right.graph,
    },
    leftNativeEvidence: [],
    rightNativeEvidence: [],
  });
  expect(
    comparison.items.filter(({ node_kind }) => node_kind === "source-module"),
  ).toEqual([
    expect.objectContaining({
      left_node_id: leftOriginal.node_id,
      right_node_id: rightOriginal.node_id,
      status: "unchanged",
    }),
  ]);

  for (const [result, original] of [
    [left, leftOriginal],
    [right, rightOriginal],
  ] as const)
    expect(
      original.observations[0]?.properties.map_file_occurrence,
    ).toMatchObject({
      container_sha256: result.root_artifact_sha256,
      path: "main.js.map",
    });

  if (leftOriginal.identity.strategy !== "source-map-original")
    throw new Error("Expected original identity");
  const { map_occurrence: _occurrence, ...historicalIdentity } =
    leftOriginal.identity;
  const historical = {
    ...leftOriginal,
    identity: historicalIdentity,
    node_id: `jag_node_${"c".repeat(64)}`,
  };
  expect(
    matchJavaScriptApplicationVersions([historical], [rightOriginal]).pairs,
  ).toHaveLength(1);
  await writeFixtureFiles(rightRoot, {
    ...files,
    "main.js.map": JSON.stringify({
      version: 3,
      sourceRoot: "webpack:///",
      sources: ["src/main.ts"],
      sourcesContent: ["export const value = 2"],
      names: [],
      mappings: "AAAA",
    }),
    "sibling.js": "right();",
  });
  const changed = await reconstructJavaScriptFixture(rightRoot);
  const [changedOriginal] = originals(changed.graph);
  if (changedOriginal === undefined)
    throw new Error("Expected changed source declaration");
  expect(
    matchJavaScriptApplicationVersions([leftOriginal], [changedOriginal])
      .pairs[0]?.basis,
  ).toBe("source-map-identity");
  const observation = historical.observations[0];
  if (
    observation?.source_map_reference === null ||
    observation?.source_map_reference === undefined
  )
    throw new Error("Expected retained map reference");
  const ambiguous = {
    ...historical,
    observations: [
      ...historical.observations,
      {
        ...observation,
        source_map_reference: {
          ...observation.source_map_reference,
          map_path: "other/main.js.map",
        },
      },
    ],
  };
  expect(
    matchJavaScriptApplicationVersions([ambiguous], [rightOriginal]).pairs,
  ).toEqual([]);
  const missing = {
    ...historical,
    observations: [{ ...observation, source_map_reference: null }],
  };
  expect(
    matchJavaScriptApplicationVersions([missing], [rightOriginal]).pairs,
  ).toEqual([]);
  const duplicate = { ...rightOriginal, node_id: `jag_node_${"d".repeat(64)}` };
  const uncertain = matchJavaScriptApplicationVersions(
    [leftOriginal],
    [rightOriginal, duplicate],
  );
  expect(uncertain.pairs).toEqual([]);
  expect(uncertain.candidatesForLeft.get(leftOriginal.node_id)).toHaveLength(2);
});

it("does not match URL-backed declarations from different map occurrences", async () => {
  const root = await createTestTempDirectory("rea-url-map-twins-");
  const map = JSON.stringify({
    version: 3,
    sourceRoot: "webpack:///",
    sources: ["src/main.ts"],
    names: [],
    mappings: "AAAA",
  });
  await writeFixtureFiles(root, {
    "left/main.js.map": map,
    "right/main.js.map": map,
  });
  const { graph } = await reconstructJavaScriptFixture(root);
  const originals = graph.nodes.filter(
    ({ identity }) => identity.strategy === "source-map-original",
  );
  expect(originals).toHaveLength(2);
  expect(
    matchJavaScriptApplicationVersions([originals[0]!], [originals[1]!]).pairs,
  ).toEqual([]);
});
