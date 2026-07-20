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

  it("projects Vite/Rollup manifests and esbuild metafiles without execution", async () => {
    const root = await esmBundlerFixture();
    try {
      const result = await reconstructJavaScriptArtifact({ input_path: root });
      const graph = result.graph;

      const viteMain = manifestChunk(graph, "vite", "src/main.ts");
      const viteFeature = manifestChunk(graph, "vite", "src/feature.ts");
      const viteVendor = manifestChunk(graph, "vite", "_vendor.js");
      const rollupEntry = manifestChunk(graph, "rollup", "src/entry.ts");
      const rollupNested = manifestChunk(graph, "rollup", "chunks/nested.js");
      const esbuildApp = manifestChunk(graph, "esbuild", "out/app.js");
      const esbuildLazy = manifestChunk(graph, "esbuild", "out/chunk.js");
      const esbuildModule = moduleNode(graph, "src/dep.js");

      expect(viteMain?.observations[0]?.properties).toMatchObject({
        bundler: "vite",
        manifest_kind: "vite-manifest",
        file: "assets/main-abc.js",
        resolved_path: "dist/assets/main-abc.js",
        entry: true,
        css: ["assets/main.css"],
        assets: ["assets/logo.svg"],
      });
      expect(edge(graph, viteMain, viteVendor, "imports")).toMatchObject({
        properties: expect.objectContaining({
          kind: "bundler-manifest-static-import",
          resolution_status: "resolved",
        }),
      });
      expect(edge(graph, viteMain, viteFeature, "imports")).toMatchObject({
        properties: expect.objectContaining({
          kind: "bundler-manifest-dynamic-import",
          resolution_status: "resolved",
        }),
      });
      expect(
        graph.edges.some(
          ({ source_node_id, relation, properties }) =>
            source_node_id === viteMain?.node_id &&
            relation === "imports" &&
            properties.kind === "bundler-manifest-asset" &&
            properties.specifier === "assets/logo.svg" &&
            properties.resolution_status === "not-found",
        ),
      ).toBe(true);

      expect(rollupEntry?.observations[0]?.properties).toMatchObject({
        bundler: "rollup",
        manifest_kind: "rollup-manifest",
        resolved_path: "rollup/chunks/entry.js",
      });
      expect(edge(graph, rollupEntry, rollupNested, "imports")).toMatchObject({
        properties: expect.objectContaining({
          kind: "bundler-manifest-dynamic-import",
          resolution_status: "resolved",
        }),
      });

      expect(esbuildApp?.observations[0]?.properties).toMatchObject({
        bundler: "esbuild",
        manifest_kind: "esbuild-metafile",
        source: "src/app.ts",
        resolved_path: "esbuild/out/app.js",
      });
      expect(edge(graph, esbuildApp, esbuildLazy, "imports")).toMatchObject({
        properties: expect.objectContaining({
          kind: "bundler-manifest-dynamic-import",
          resolution_status: "resolved",
        }),
      });
      expect(esbuildModule?.observations[0]?.properties).toMatchObject({
        bundler: "esbuild",
        module_key: "src/dep.js",
      });
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

const esmBundlerFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-esm-bundler-adapters-"));
  await mkdir(join(root, "dist", ".vite"), { recursive: true });
  await mkdir(join(root, "dist", "assets"), { recursive: true });
  await mkdir(join(root, "rollup", "chunks"), { recursive: true });
  await mkdir(join(root, "esbuild", "out"), { recursive: true });
  await writeFile(
    join(root, "dist", ".vite", "manifest.json"),
    JSON.stringify(
      {
        "src/main.ts": {
          file: "assets/main-abc.js",
          src: "src/main.ts",
          isEntry: true,
          imports: ["_vendor.js"],
          dynamicImports: ["src/feature.ts"],
          css: ["assets/main.css"],
          assets: ["assets/logo.svg"],
        },
        "src/feature.ts": {
          file: "assets/feature-def.js",
          src: "src/feature.ts",
          isDynamicEntry: true,
          imports: ["_vendor.js"],
        },
        "_vendor.js": { file: "assets/vendor.js" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "dist", "assets", "main-abc.js"),
    `
      import { helper } from "./vendor.js";
      const __vite__mapDeps = (i, m = __vite__mapDeps, d = (m.f || (m.f = ["./feature-def.js", "./main.css"]))) => i.map((i) => d[i]);
      export const start = () => __vitePreload(() => import("./feature-def.js"), __vite__mapDeps([0, 1]));
      helper();
    `,
  );
  await writeFile(
    join(root, "dist", "assets", "feature-def.js"),
    `export const feature = "feature";`,
  );
  await writeFile(
    join(root, "dist", "assets", "vendor.js"),
    `export const helper = () => "vendor";`,
  );
  await writeFile(
    join(root, "rollup", "rollup-manifest.json"),
    JSON.stringify(
      {
        "src/entry.ts": {
          file: "chunks/entry.js",
          isEntry: true,
          imports: ["chunks/shared.js"],
          dynamicImports: ["chunks/nested.js"],
        },
        "chunks/shared.js": { file: "chunks/shared.js" },
        "chunks/nested.js": { file: "chunks/nested.js" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "rollup", "chunks", "entry.js"),
    `import "./shared.js"; export const nested = () => import("./nested.js");`,
  );
  await writeFile(
    join(root, "rollup", "chunks", "shared.js"),
    `export const shared = true;`,
  );
  await writeFile(
    join(root, "rollup", "chunks", "nested.js"),
    `export const nested = true;`,
  );
  await writeFile(
    join(root, "esbuild", "esbuild-metafile.json"),
    JSON.stringify(
      {
        inputs: {
          "src/app.ts": {},
          "src/lazy.ts": {},
        },
        outputs: {
          "out/app.js": {
            entryPoint: "src/app.ts",
            imports: [
              { path: "out/shared.js", kind: "import-statement" },
              { path: "out/chunk.js", kind: "dynamic-import" },
            ],
          },
          "out/chunk.js": { entryPoint: "src/lazy.ts", imports: [] },
          "out/shared.js": { imports: [] },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "esbuild", "out", "app.js"),
    `
      var require_dep = __commonJS({
        "src/dep.js"(exports, module) {
          module.exports = { value: 1 };
        }
      });
      var init_core = __esm({
        "src/core.js"() {
          require_dep();
        }
      });
      init_core();
      import("./chunk.js");
    `,
  );
  await writeFile(
    join(root, "esbuild", "out", "chunk.js"),
    `export const lazy = true;`,
  );
  await writeFile(
    join(root, "esbuild", "out", "shared.js"),
    `export const shared = true;`,
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

const manifestChunk = (
  graph: JavaScriptApplicationGraph,
  bundler: string,
  entryKey: string,
): ApplicationNode | undefined =>
  graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-chunk" &&
      observations.some(
        ({ properties }) =>
          properties.bundler === bundler && properties.entry_key === entryKey,
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
