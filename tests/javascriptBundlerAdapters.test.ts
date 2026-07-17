import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../src/application/JavaScriptArtifactReconstruction.js";
import type {
  ApplicationEdge,
  ApplicationNode,
  JavaScriptApplicationGraph,
} from "../src/domain/javascriptApplicationGraph.js";

describe("Webpack and Rspack runtime adapters", () => {
  it("recovers runtime entry modules, async chunks, and factory require aliases", async () => {
    const root = await bundlerFixture();
    try {
      const result = await reconstructJavaScriptArtifact({ input_path: root });
      const graph = result.graph;

      const webpackEntry = chunk(graph, "webpackChunkcustomPortal", "main");
      const webpackLazy = chunk(graph, "webpackChunkcustomPortal", "lazy");
      const webpackModule = moduleNode(graph, "10");
      const rspackEntry = chunk(graph, "rspackChunkcustomPortal", "editor");
      const rspackModel = chunk(graph, "rspackChunkcustomPortal", "model");
      const rspackModule = moduleNode(graph, "src/entry.ts");

      expect(webpackEntry?.observations[0]?.properties).toMatchObject({
        bundler: "webpack",
        runtime_require_name: "__webpack_require__",
        runtime_module_cache_status: "observed",
        entry_module_keys: ["10"],
        async_chunk_keys: ["lazy", "missing"],
        unknown_async_chunk_keys: 1,
      });
      expect(webpackModule?.observations[0]?.properties).toMatchObject({
        factory_require_name: "__webpack_require__",
        runtime_entry: true,
        chunk_keys: ["main"],
      });
      expect(rspackEntry?.observations[0]?.properties).toMatchObject({
        bundler: "rspack",
        runtime_require_name: "r",
        entry_module_keys: ["src/entry.ts"],
        async_chunk_keys: ["model"],
      });
      expect(rspackModule?.observations[0]?.properties).toMatchObject({
        factory_require_name: "r",
        runtime_entry: true,
      });

      expect(edge(graph, webpackEntry, webpackModule, "loads")).toMatchObject({
        properties: expect.objectContaining({
          kind: "bundler-entry-module",
          resolution_status: "resolved",
        }),
      });
      expect(edge(graph, webpackEntry, webpackLazy, "imports")).toMatchObject({
        properties: expect.objectContaining({
          kind: "bundler-async-chunk",
          resolution_status: "resolved",
        }),
      });
      expect(edge(graph, webpackModule, webpackLazy, "imports")).toMatchObject({
        properties: expect.objectContaining({
          kind: "dynamic-import",
          specifier: "chunk:lazy",
          resolved_path: "renderer/chunks/runtime.js#chunk:lazy",
        }),
      });
      expect(edge(graph, rspackEntry, rspackModel, "imports")).toMatchObject({
        properties: expect.objectContaining({
          kind: "bundler-async-chunk",
          resolution_status: "resolved",
        }),
      });
      expect(edge(graph, rspackModule, rspackModel, "imports")).toMatchObject({
        properties: expect.objectContaining({
          kind: "dynamic-import",
          specifier: "chunk:model",
        }),
      });

      expect(
        graph.nodes.find((node) =>
          node.observations.some(
            ({ properties }) =>
              properties.semantic_role === "bundler-chunk-reference" &&
              properties.chunk_key === "missing" &&
              properties.resolution_status === "not-found",
          ),
        ),
      ).toBeDefined();
      expect(
        graph.edges.some(
          ({ relation, properties }) =>
            relation === "imports" &&
            properties.kind === "require" &&
            properties.specifier === "lazy",
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const bundlerFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-bundler-adapters-"));
  await mkdir(join(root, "renderer", "chunks"), { recursive: true });
  await writeFile(
    join(root, "renderer", "chunks", "runtime.js"),
    `
      var __webpack_module_cache__ = {};
      (globalThis["webpackChunkcustomPortal"] = globalThis["webpackChunkcustomPortal"] || []).push([
        ["main"],
        {
          10: (module, exports, __webpack_require__) => {
            const direct = __webpack_require__(11);
            const lazy = __webpack_require__.e("lazy").then(
              __webpack_require__.bind(__webpack_require__, 20)
            );
            const missing = __webpack_require__.e("missing");
            const dynamicChunk = window.name;
            __webpack_require__.e(dynamicChunk);
            exports.start = () => [direct, lazy, missing];
          },
          11: (module) => { module.exports = "direct"; }
        },
        (__webpack_require__) => {
          __webpack_require__.O(0, ["main"], () => __webpack_require__(10));
        }
      ]);
      (globalThis["webpackChunkcustomPortal"] = globalThis["webpackChunkcustomPortal"] || []).push([
        ["lazy"],
        {
          20: (module) => { module.exports = "lazy"; }
        }
      ]);
      (self.rspackChunkcustomPortal = self.rspackChunkcustomPortal || []).push([
        ["editor"],
        {
          "src/entry.ts": (module, exports, r) => {
            r.e("model").then(r.bind(r, "src/model.ts"));
            exports.render = () => r("src/model.ts");
          }
        },
        (r) => { r("src/entry.ts"); }
      ]);
      (self.rspackChunkcustomPortal = self.rspackChunkcustomPortal || []).push([
        ["model"],
        {
          "src/model.ts": (module) => { module.exports = "model"; }
        }
      ]);
    `,
  );
  return root;
};

const chunk = (
  graph: JavaScriptApplicationGraph,
  runtime: string,
  chunkKey: string,
): ApplicationNode | undefined =>
  graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-chunk" &&
      observations.some(
        ({ properties }) =>
          properties.runtime === runtime &&
          Array.isArray(properties.chunk_keys) &&
          properties.chunk_keys.includes(chunkKey),
      ),
  );

const moduleNode = (
  graph: JavaScriptApplicationGraph,
  moduleKey: string,
): ApplicationNode | undefined =>
  graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-module" &&
      observations.some(
        ({ properties }) => properties.module_key === moduleKey,
      ),
  );

const edge = (
  graph: JavaScriptApplicationGraph,
  source: ApplicationNode | undefined,
  target: ApplicationNode | undefined,
  relation: string,
): ApplicationEdge | undefined =>
  graph.edges.find(
    ({ source_node_id, target_node_id, relation: edgeRelation }) =>
      source !== undefined &&
      target !== undefined &&
      source_node_id === source.node_id &&
      target_node_id === target.node_id &&
      edgeRelation === relation,
  );
