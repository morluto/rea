import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseJavaScriptApplicationGraph } from "../../../src/domain/javascript/javascriptApplicationGraph.js";

import {
  findExportNode,
  findRelationshipEdge,
  findSourceModule,
  reconstructJavaScriptFixture,
  writeFixtureFiles,
} from "../../support/javascriptApplicationFixture.js";

describe("CommonJS and ESM module relationships", () => {
  it("composes bindings, re-exports, dynamic imports, and JSON modules", async () => {
    const root = await moduleFixture();
    const first = await reconstructJavaScriptFixture(root);
    const second = await reconstructJavaScriptFixture(root);
    const graph = first.graph;

    expect(second.graph).toEqual(graph);
    expect(findSourceModule(graph, "main.cjs")).toBeDefined();
    expect(findSourceModule(graph, "consumer.mjs")).toBeDefined();
    expect(findSourceModule(graph, "dependency.mjs")).toBeDefined();

    expect(
      findRelationshipEdge(graph, {
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
          relation === "imports" && properties.specifier === "fixture-package",
      ),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({ resolved_path: null }),
        }),
      ]),
    );
    expect(
      findRelationshipEdge(graph, {
        kind: "require",
        specifier: "fixture-package",
        resolvedPath: "node_modules/fixture-package/cjs.cjs",
        localName: "packageValue",
      }),
    ).toBeDefined();
    expect(
      findRelationshipEdge(graph, {
        kind: "import",
        specifier: "fixture-package",
        resolvedPath: "node_modules/fixture-package/esm.mjs",
        importedName: "default",
        localName: "packageDefault",
      }),
    ).toBeDefined();
    expect(
      findRelationshipEdge(graph, {
        kind: "import",
        specifier: "./values.js",
        resolvedPath: "values.js",
        importedName: "value",
        localName: "alias",
      }),
    ).toBeDefined();
    expect(
      findRelationshipEdge(graph, {
        kind: "re-export",
        specifier: "./star.js",
        resolvedPath: "star.js",
        importedName: "*",
        exportedName: "*",
      }),
    ).toBeDefined();

    const forwarded = findExportNode(graph, "main.cjs", "forwarded");
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
      source_node_id: findSourceModule(graph, "consumer.mjs")?.node_id,
    });

    expect(
      findRelationshipEdge(graph, {
        kind: "require",
        specifier: "./data.json",
        resolvedPath: "data.json",
      })?.properties,
    ).toMatchObject({
      target_file_kind: "json",
      target_json_status: "included",
    });
    expect(
      findRelationshipEdge(graph, {
        kind: "require",
        specifier: "./broken.json",
        resolvedPath: "broken.json",
      })?.properties,
    ).toMatchObject({
      target_file_kind: "json",
      target_json_status: "invalid",
    });
    expect(
      findRelationshipEdge(graph, {
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
  });
});

it("does not assign one module origin to an export with colliding path encodings", async () => {
  const root = await createTestTempDirectory("rea-ambiguous-module-origin-");
  await writeFixtureFiles(root, {
    "index.js": String.raw`
        import * as ns from "./fixture.js";
        const selected = choice ? ns["a\0b"] : ns.a.b;
        export { selected };
      `,
    "fixture.js": "export const fixture = true;\n",
  });
  const { graph } = await reconstructJavaScriptFixture(root);
  const applicationGraph = parseJavaScriptApplicationGraph(
    JSON.parse(JSON.stringify(graph)),
  );
  const selectedExport = findExportNode(
    applicationGraph,
    "index.js",
    "selected",
  );
  if (selectedExport === undefined)
    throw new Error("Expected the selected export node");

  expect(
    applicationGraph.edges.filter(
      ({ relation, source_node_id, properties }) =>
        relation === "imports" &&
        source_node_id === selectedExport.node_id &&
        properties.local_name === "selected",
    ),
  ).toEqual([]);
});

describe("complete static application projections", () => {
  it("retains exports and JSON keys beyond the former projection prefix", async () => {
    const root = await moduleFixture();
    const exportNames = Array.from(
      { length: 140 },
      (_, index) =>
        `export const retained_${String(index).padStart(3, "0")} = ${index};`,
    );
    const jsonKeys = Object.fromEntries(
      Array.from({ length: 140 }, (_, index) => [`key_${index}`, index]),
    );
    await Promise.all([
      writeFile(join(root, "many-exports.mjs"), exportNames.join("\n")),
      writeFile(join(root, "many.json"), JSON.stringify(jsonKeys)),
    ]);

    const { graph } = await reconstructJavaScriptFixture(root);
    const module = findSourceModule(graph, "many-exports.mjs");
    const exportObservation = module?.observations.find(
      ({ properties }) => properties.semantic_role === "source-module",
    );
    const json = graph.nodes.find((node) =>
      node.observations.some(
        ({ properties }) => properties.path === "many.json",
      ),
    );
    const jsonObservation = json?.observations.find(
      ({ properties }) => properties.path === "many.json",
    );

    expect(exportObservation?.properties.export_names).toHaveLength(140);
    expect(exportObservation?.properties.omitted_export_names).toBe(0);
    expect(jsonObservation?.properties.json_top_level_keys).toHaveLength(140);
    expect(jsonObservation?.properties.omitted_json_top_level_keys).toBe(0);
  });
});

const moduleFixture = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-module-relationships-");
  await writeFixtureFiles(root, {
    "package.json": '{"main":"main.cjs"}',
    "main.cjs": `
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
    "dependency.mjs": `
        export { value } from "./values.js";
        export * from "./star.js";
      `,
    "consumer.mjs": `
        import { value as alias } from "./values.js";
        import packageDefault from "fixture-package";
        export { alias as relayed };
        void import("./lazy.js");
        void packageDefault;
      `,
    "values.js": "export const value = 42;",
    "star.js": "export const extra = true;",
    "lazy.js": "export default 'lazy';",
    "data.json": '{"name":"fixture","value":42}',
    "broken.json": '{"name":',
    "node_modules/fixture-package/package.json": JSON.stringify({
      exports: {
        ".": {
          import: "./esm.mjs",
          require: "./cjs.cjs",
        },
      },
    }),
    "node_modules/fixture-package/esm.mjs": "export default 'esm';",
    "node_modules/fixture-package/cjs.cjs": "module.exports = 'cjs';",
  });
  return root;
};
