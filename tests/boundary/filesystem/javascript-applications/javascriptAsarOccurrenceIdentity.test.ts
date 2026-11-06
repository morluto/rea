import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { reconstructJavaScriptFixture } from "../../../support/javascriptApplicationFixture.js";
import { findApplicationFeatureSeeds } from "../../../../src/domain/javascript/javascriptFeatureSeed.js";
import { traverseApplicationFeature } from "../../../../src/domain/javascript/javascriptFeatureTraversal.js";

it("keeps identical nested asar occurrences distinct", async () => {
  const parent = await createTestTempDirectory("rea-duplicate-asar-");
  const input = join(parent, "input");
  const source = join(parent, "source");
  await mkdir(input);
  await mkdir(source);
  await writeFile(join(source, "main.js"), "console.log('hello')");
  await createPackageWithOptions(source, join(input, "left.asar"), {});
  await copyFile(join(input, "left.asar"), join(input, "right.asar"));
  const graph = (await reconstructJavaScriptFixture(input)).graph;
  const archives = graph.nodes.filter(
    (n) =>
      n.kind === "artifact" &&
      n.observations.some(
        (o) => o.label === "left.asar" || o.label === "right.asar",
      ),
  );
  const seeds = findApplicationFeatureSeeds(graph.nodes, {
    kind: "string",
    value: "left.asar",
    match: "exact",
    case_sensitive: true,
  });
  const trace = traverseApplicationFeature(
    graph,
    seeds.map((s) => s.node_id),
    "outgoing",
  );
  expect(archives).toHaveLength(2);
  const paths = trace.nodes.flatMap((node) =>
    node.observations.map((observation) => observation.label),
  );
  expect(paths).toContain("left.asar/main.js");
  expect(paths).not.toContain("right.asar/main.js");
});
