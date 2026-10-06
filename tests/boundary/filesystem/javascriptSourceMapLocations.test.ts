import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])(
  "preserves source-map graph evidence coordinates after %j",
  async (separator) => {
    const root = await createTestTempDirectory("rea-source-map-locations-");
    const directive = "//# sourceMappingURL=app.js.map";
    const source = `const marker = "😀";${separator}  ${directive}`;
    await writeFile(join(root, "app.js"), source);
    const result = await reconstructJavaScriptArtifact({ input_path: root });
    expect(result.statistics.parse_failures).toBe(0);
    const edges = result.graph.edges.filter(
      ({ relation, properties }) =>
        relation === "maps_to" && properties.declared_url === "app.js.map",
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.evidence).toMatchObject({
      state: "inferred",
      artifact: {
        sha256: createHash("sha256").update(source).digest("hex"),
      },
      location: {
        available: true,
        value: {
          kind: "source-range",
          source: "app.js",
          start: { line: 2, column: 2 },
          end: { line: 2, column: directive.length + 2 },
        },
      },
    });
    expect(edges[0]?.properties).toMatchObject({
      declared_url: "app.js.map",
      resolved_path: null,
    });
  },
);

it("resolves a bare source-map file name and worker URL next to the script", async () => {
  const root = await createTestTempDirectory("rea-source-map-relative-");
  await mkdir(join(root, "dist"));
  await writeFile(
    join(root, "dist", "app.js"),
    'new Worker("worker.js");\n//# sourceMappingURL=app.js.map',
  );
  await writeFile(
    join(root, "dist", "worker.js"),
    "self.onmessage = () => {};",
  );
  await writeFile(
    join(root, "dist", "app.js.map"),
    JSON.stringify({
      version: 3,
      sources: ["../src/app.js"],
      sourcesContent: ['new Worker("worker.js");'],
      names: [],
      mappings: "AAAA",
    }),
  );
  const result = await reconstructJavaScriptArtifact({ input_path: root });
  const nodes = new Map(result.graph.nodes.map((node) => [node.node_id, node]));
  const mapEdge = result.graph.edges.find(
    ({ relation, properties }) =>
      relation === "maps_to" && properties.declared_url === "app.js.map",
  );
  expect(mapEdge?.properties).toMatchObject({
    declared_url: "app.js.map",
    resolved_path: "dist/app.js.map",
  });
  expect(nodes.get(mapEdge?.target_node_id ?? "")?.identity.strategy).toBe(
    "content-digest",
  );
  const workerEdge = result.graph.edges.find(
    ({ relation, source_node_id }) =>
      relation === "maps_to" && nodes.get(source_node_id)?.kind === "worker",
  );
  expect(workerEdge?.properties).toMatchObject({
    resolved_path: "dist/worker.js",
  });
});
