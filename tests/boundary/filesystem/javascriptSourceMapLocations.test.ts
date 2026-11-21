import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../support/javascriptApplicationScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  parseJavaScriptApplicationGraph,
  serializeJavaScriptApplicationGraph,
} from "../../../src/domain/javascript/javascriptApplicationGraph.js";

it("publishes the location of real source-map comments across JavaScript line breaks", async () => {
  const root = await createTestTempDirectory("rea-source-map-locations-");
  const directive = "//# sourceMappingURL=app.js.map";
  const quoted = [
    'const marker = "😀 //# sourceMappingURL=ghost.map";',
    "const template = `/*# sourceMappingURL=template.map */`;",
  ].join(" ");
  const files = ["\n", "\r\n", "\r", "\u2028", "\u2029"].map(
    (separator, index) => ({
      name: `app-${index}.js`,
      text: `${quoted}${separator}  ${directive}`,
    }),
  );
  await Promise.all(
    files.map(({ name, text }) => writeFile(join(root, name), text)),
  );

  const result = await reconstructJavaScriptArtifact({ input_path: root });
  expect(result.statistics.parse_failures).toBe(0);
  const nodes = new Map(result.graph.nodes.map((node) => [node.node_id, node]));
  const edges = result.graph.edges.filter(
    ({ relation, target_node_id }) =>
      relation === "maps_to" &&
      nodes.get(target_node_id)?.kind === "source-map",
  );
  expect(edges).toHaveLength(files.length);
  for (const { name, text } of files)
    expect(edges).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          declared_url_sha256: createHash("sha256")
            .update("app.js.map")
            .digest("hex"),
          resolved_path: null,
        }),
        evidence: expect.objectContaining({
          state: "inferred",
          artifact: expect.objectContaining({
            sha256: createHash("sha256").update(text).digest("hex"),
          }),
          location: {
            available: true,
            value: {
              kind: "source-range",
              source: name,
              start: { line: 2, column: 2 },
              end: { line: 2, column: directive.length + 2 },
            },
          },
        }),
      }),
    );
  const declaredUrls = result.graph.nodes
    .filter(({ kind }) => kind === "source-map")
    .flatMap(({ observations }) =>
      observations.map(({ properties }) => properties.declared_url),
    );
  expect(new Set(declaredUrls)).toEqual(new Set(["app.js.map"]));
});

it("owns an inline source-map URL once and recovers it from the target after JSON roundtrip", async () => {
  const root = await createTestTempDirectory("rea-inline-source-map-url-");
  const sourceContent = "source;".repeat(16_384);
  const sourceMap = JSON.stringify({
    version: 3,
    sources: ["src/app.js"],
    sourcesContent: [sourceContent],
    names: [],
    mappings: "AAAA",
  });
  const declaredUrl = `data:application/json;base64,${Buffer.from(sourceMap).toString("base64")}`;
  await writeFile(
    join(root, "app.js"),
    `const app = true;\n//# sourceMappingURL=${declaredUrl}\n`,
  );

  const result = await reconstructJavaScriptArtifact({ input_path: root });
  const serialized = serializeJavaScriptApplicationGraph(result.graph);
  const graph = parseJavaScriptApplicationGraph(JSON.parse(serialized));
  const edge = graph.edges.find(
    ({ relation, target_node_id }) =>
      relation === "maps_to" &&
      graph.nodes.some(
        ({ kind, node_id }) =>
          kind === "source-map" && node_id === target_node_id,
      ),
  );
  const target = graph.nodes.find(
    ({ node_id }) => node_id === edge?.target_node_id,
  );

  const edgeUrlSha256 = edge?.properties.declared_url_sha256;
  const observation = target?.observations.find(
    ({ properties }) => properties.declared_url_sha256 === edgeUrlSha256,
  );
  expect(edgeUrlSha256).toBe(
    createHash("sha256").update(declaredUrl).digest("hex"),
  );
  expect(observation?.properties.declared_url).toBe(declaredUrl);
  expect(observation?.properties).toMatchObject({
    resolved_path: null,
    available: false,
  });
  expect(serialized.split(declaredUrl)).toHaveLength(2);
});

it("associates each source-map URL with its edge when aliases share one physical map", async () => {
  const root = await createTestTempDirectory("rea-source-map-aliases-");
  await mkdir(join(root, "dist"));
  await writeFile(
    join(root, "dist", "app.js.map"),
    JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }),
  );
  await writeFile(
    join(root, "dist", "one.js"),
    "//# sourceMappingURL=app.js.map\n",
  );
  await writeFile(
    join(root, "dist", "two.js"),
    "//# sourceMappingURL=./app.js.map\n",
  );

  const result = await reconstructJavaScriptArtifact({ input_path: root });
  const serialized = serializeJavaScriptApplicationGraph(result.graph);
  const graph = parseJavaScriptApplicationGraph(JSON.parse(serialized));
  const nodes = new Map(graph.nodes.map((node) => [node.node_id, node]));
  const mapEdges = graph.edges.filter(
    ({ relation, target_node_id }) =>
      relation === "maps_to" &&
      nodes.get(target_node_id)?.kind === "source-map",
  );
  expect(mapEdges).toHaveLength(2);
  expect(mapEdges[0]?.target_node_id).toBe(mapEdges[1]?.target_node_id);
  const mapNode = nodes.get(mapEdges[0]?.target_node_id ?? "");
  expect(mapNode?.identity.strategy).toBe("content-digest");
  // Edge order follows content-derived edge IDs, so pair each edge with the
  // script whose comment declared it.
  const declaredBySource = new Map(
    mapEdges.map((edge) => {
      const target = nodes.get(edge.target_node_id);
      const observation = target?.observations.find(
        ({ properties }) =>
          properties.declared_url_sha256 ===
          edge.properties.declared_url_sha256,
      );
      const location = edge.evidence.location;
      return [
        location.available && location.value.kind === "source-range"
          ? location.value.source
          : null,
        {
          declared_url: observation?.properties.declared_url,
          resolved_path: edge.properties.resolved_path,
          resolution_status: edge.properties.resolution_status,
          available: observation?.properties.available,
        },
      ];
    }),
  );
  expect(Object.fromEntries(declaredBySource)).toEqual({
    "dist/one.js": {
      declared_url: "app.js.map",
      resolved_path: "dist/app.js.map",
      resolution_status: "resolved",
      available: true,
    },
    "dist/two.js": {
      declared_url: "./app.js.map",
      resolved_path: "dist/app.js.map",
      resolution_status: "resolved",
      available: true,
    },
  });
});

it("resolves a module worker relative to its script while keeping the document base unknown", async () => {
  const root = await createTestTempDirectory("rea-source-map-relative-");
  await mkdir(join(root, "dist"));
  await writeFile(
    join(root, "dist", "app.js"),
    [
      'new Worker(new URL("worker.js", import.meta.url));',
      'navigator.serviceWorker.register("sw.js");',
    ].join("\n"),
  );
  await writeFile(
    join(root, "dist", "worker.js"),
    "self.onmessage = () => {};",
  );
  await writeFile(join(root, "dist", "sw.js"), "self.onfetch = () => {};");
  const result = await reconstructJavaScriptArtifact({ input_path: root });
  const nodes = new Map(result.graph.nodes.map((node) => [node.node_id, node]));
  const workerEdge = result.graph.edges.find(
    ({ relation, source_node_id }) =>
      relation === "maps_to" && nodes.get(source_node_id)?.kind === "worker",
  );
  expect(workerEdge?.properties).toMatchObject({
    resolved_path: "dist/worker.js",
  });
  // A service worker URL is relative to the unestablished document base.
  expect(
    result.graph.edges.some(
      ({ relation, source_node_id }) =>
        relation === "maps_to" &&
        nodes.get(source_node_id)?.kind === "service-worker",
    ),
  ).toBe(false);
});
