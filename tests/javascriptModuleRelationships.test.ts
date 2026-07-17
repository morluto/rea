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

describe("CommonJS and ESM module relationships", () => {
  it("composes bindings, re-exports, dynamic imports, and JSON modules", async () => {
    const root = await moduleFixture();
    try {
      const first = await reconstructJavaScriptArtifact({ input_path: root });
      const second = await reconstructJavaScriptArtifact({ input_path: root });
      const graph = first.graph;

      expect(second.graph).toEqual(graph);
      expect(sourceModule(graph, "main.cjs")).toBeDefined();
      expect(sourceModule(graph, "consumer.mjs")).toBeDefined();
      expect(sourceModule(graph, "dependency.mjs")).toBeDefined();

      expect(
        relationship(graph, {
          kind: "require",
          specifier: "./dependency.mjs",
          resolvedPath: "dependency.mjs",
          importedName: "value",
          localName: "importedValue",
        }),
      ).toBeDefined();
      expect(
        graph.edges.filter(
          ({ relation, properties }) =>
            relation === "imports" &&
            properties.specifier === "fixture-package",
        ),
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ resolved_path: null }),
          }),
        ]),
      );
      expect(
        relationship(graph, {
          kind: "require",
          specifier: "fixture-package",
          resolvedPath: "node_modules/fixture-package/cjs.cjs",
          localName: "packageValue",
        }),
      ).toBeDefined();
      expect(
        relationship(graph, {
          kind: "import",
          specifier: "fixture-package",
          resolvedPath: "node_modules/fixture-package/esm.mjs",
          importedName: "default",
          localName: "packageDefault",
        }),
      ).toBeDefined();
      expect(
        relationship(graph, {
          kind: "import",
          specifier: "./values.js",
          resolvedPath: "values.js",
          importedName: "value",
          localName: "alias",
        }),
      ).toBeDefined();
      expect(
        relationship(graph, {
          kind: "re-export",
          specifier: "./star.js",
          resolvedPath: "star.js",
          importedName: "*",
          exportedName: "*",
        }),
      ).toBeDefined();

      const forwarded = exportNode(graph, "main.cjs", "forwarded");
      expect(forwarded).toBeDefined();
      expect(
        graph.edges.some(
          ({ source_node_id, relation, properties }) =>
            source_node_id === forwarded?.node_id &&
            relation === "imports" &&
            properties.resolved_path === "dependency.mjs" &&
            properties.imported_name === "value",
        ),
      ).toBe(true);

      expect(
        graph.edges.find(
          ({ relation, properties }) =>
            relation === "imports" &&
            properties.kind === "dynamic-import" &&
            properties.resolved_path === "lazy.js",
        ),
      ).toMatchObject({
        source_node_id: sourceModule(graph, "consumer.mjs")?.node_id,
      });

      expect(
        relationship(graph, {
          kind: "require",
          specifier: "./data.json",
          resolvedPath: "data.json",
        })?.properties,
      ).toMatchObject({
        target_file_kind: "json",
        target_json_status: "included",
      });
      expect(
        relationship(graph, {
          kind: "require",
          specifier: "./broken.json",
          resolvedPath: "broken.json",
        })?.properties,
      ).toMatchObject({
        target_file_kind: "json",
        target_json_status: "invalid",
      });
      expect(
        relationship(graph, {
          kind: "require",
          specifier: "electron",
        })?.properties,
      ).toMatchObject({ resolution_status: "external", resolved_path: null });
      expect(
        graph.edges.find(
          ({ relation, properties }) =>
            relation === "imports" &&
            properties.kind === "require" &&
            properties.specifier === null,
        )?.properties,
      ).toMatchObject({ resolved_path: null });

      expect(first.statistics.parse_failures).toBe(1);
      expect(graph.coverage).toMatchObject({
        status: "partial",
        truncated: false,
      });
      expect(graph.limitations.join(" ")).toMatch(/incomplete/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains exact semantic omissions when the relationship budget truncates", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-module-limit-"));
    try {
      await writeFile(
        join(root, "exports.mjs"),
        "export const first = 1; export const second = 2; export const third = 3;",
      );
      const result = await reconstructJavaScriptArtifact({
        input_path: root,
        limits: { max_findings: 1 },
      });

      expect(result.statistics.truncated_scopes).toBeGreaterThan(0);
      expect(
        result.graph.nodes.filter((node) =>
          node.observations.some(
            ({ properties }) => properties.semantic_role === "export-binding",
          ),
        ),
      ).toHaveLength(1);
      expect(result.graph.coverage).toMatchObject({
        status: "partial",
        truncated: true,
        omitted_count: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const moduleFixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-module-relationships-"));
  await mkdir(join(root, "node_modules", "fixture-package"), {
    recursive: true,
  });
  await Promise.all([
    writeFile(join(root, "package.json"), '{"main":"main.cjs"}'),
    writeFile(
      join(root, "main.cjs"),
      `
        const { value: importedValue } = require("./dependency.mjs");
        const data = require("./data.json");
        const broken = require("./broken.json");
        const electron = require("electron");
        const packageValue = require("fixture-package");
        module.exports.forwarded = importedValue;
        exports.data = data;
        exports.broken = broken;
        exports.electron = electron;
        exports.packageValue = packageValue;
        require(dynamicName);
      `,
    ),
    writeFile(
      join(root, "dependency.mjs"),
      `
        export { value } from "./values.js";
        export * from "./star.js";
      `,
    ),
    writeFile(
      join(root, "consumer.mjs"),
      `
        import { value as alias } from "./values.js";
        import packageDefault from "fixture-package";
        export { alias as relayed };
        void import("./lazy.js");
        void packageDefault;
      `,
    ),
    writeFile(join(root, "values.js"), "export const value = 42;"),
    writeFile(join(root, "star.js"), "export const extra = true;"),
    writeFile(join(root, "lazy.js"), "export default 'lazy';"),
    writeFile(join(root, "data.json"), '{"name":"fixture","value":42}'),
    writeFile(join(root, "broken.json"), '{"name":'),
    writeFile(
      join(root, "node_modules", "fixture-package", "package.json"),
      JSON.stringify({
        exports: {
          ".": {
            import: "./esm.mjs",
            require: "./cjs.cjs",
          },
        },
      }),
    ),
    writeFile(
      join(root, "node_modules", "fixture-package", "esm.mjs"),
      "export default 'esm';",
    ),
    writeFile(
      join(root, "node_modules", "fixture-package", "cjs.cjs"),
      "module.exports = 'cjs';",
    ),
  ]);
  return root;
};

interface RelationshipQuery {
  readonly kind: string;
  readonly specifier: string;
  readonly resolvedPath?: string;
  readonly importedName?: string;
  readonly localName?: string;
  readonly exportedName?: string;
}

const relationship = (
  graph: JavaScriptApplicationGraph,
  query: RelationshipQuery,
): ApplicationEdge | undefined =>
  graph.edges.find(
    ({ relation, properties }) =>
      relation === "imports" &&
      properties.module_link_kind === query.kind &&
      properties.specifier === query.specifier &&
      (query.resolvedPath === undefined ||
        properties.resolved_path === query.resolvedPath) &&
      (query.importedName === undefined ||
        properties.imported_name === query.importedName) &&
      (query.localName === undefined ||
        properties.local_name === query.localName) &&
      (query.exportedName === undefined ||
        properties.exported_name === query.exportedName),
  );

const sourceModule = (
  graph: JavaScriptApplicationGraph,
  path: string,
): ApplicationNode | undefined =>
  graph.nodes.find(
    (node) =>
      node.kind === "javascript-module" &&
      node.observations.some(
        ({ properties }) => properties.logical_module_key === path,
      ),
  );

const exportNode = (
  graph: JavaScriptApplicationGraph,
  path: string,
  name: string,
): ApplicationNode | undefined =>
  graph.nodes.find(
    (node) =>
      node.kind === "javascript-module" &&
      node.observations.some(
        ({ properties }) =>
          properties.semantic_role === "export-binding" &&
          properties.module_path === path &&
          properties.exported_name === name,
      ),
  );
