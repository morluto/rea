import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("creates source-map graph relationships only for real comments", async () => {
  const root = await createTestTempDirectory("rea-source-map-comments-");
  const path = join(root, "documentation.js");
  const quoted = 'const documentation = "//# sourceMappingURL=ghost.map ";';
  await writeFile(path, quoted);
  const withoutDirective = await reconstructJavaScriptArtifact({
    input_path: root,
  });
  expect(withoutDirective.statistics.parse_failures).toBe(0);
  expect(
    withoutDirective.graph.nodes.filter(({ kind }) => kind === "source-map"),
  ).toEqual([]);
  expect(
    withoutDirective.graph.edges.filter(
      ({ relation, properties }) =>
        relation === "maps_to" && properties.declared_url !== undefined,
    ),
  ).toEqual([]);

  await writeFile(path, `${quoted}\n//# sourceMappingURL=real.map\n`);
  const withDirective = await reconstructJavaScriptArtifact({
    input_path: root,
  });
  expect(
    withDirective.graph.nodes.filter(({ kind }) => kind === "source-map"),
  ).toHaveLength(1);
  expect(
    withDirective.graph.edges
      .filter(
        ({ relation, properties }) =>
          relation === "maps_to" && properties.declared_url !== undefined,
      )
      .map(({ properties }) => properties.declared_url),
  ).toEqual(["real.map"]);
});
