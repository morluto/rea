import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { buildJavaScriptNativeHandoffs } from "../../../src/domain/javascript/javascriptNativeHandoff.js";
import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const analyzeFixture = async (source: string, addonPath = "addon.node") => {
  const fixture = await createTestTempDirectory("rea-native-types-");
  const scope = new ArtifactResourceScope();
  try {
    await writeFile(join(fixture, "main.ts"), `${source}\n`);
    await writeFile(join(fixture, addonPath), "");
    const result = await analyzeJavaScriptApplication(
      { input_path: fixture, format: "directory" },
      scope,
    );
    if (!result.ok) throw result.error;
    return javascriptApplicationAnalysisResultSchema.parse(
      result.value.normalized_result,
    );
  } finally {
    await scope.close();
  }
};

it("does not request native-addon members from erased TypeScript names", async () => {
  const typeImport = await analyzeFixture(
    'import type { NativeThing } from "./addon.node";',
  );
  expect(typeImport.summary.native_addon_bindings).toBe(0);
  expect(typeImport.summary.resolved_native_addon_bindings).toBe(0);
  expect(
    typeImport.graph.nodes.filter((node) => node.kind === "native-export"),
  ).toEqual([]);
  expect(
    buildJavaScriptNativeHandoffs(
      typeImport.graph,
      new Set(typeImport.graph.nodes.map((node) => node.node_id)),
      [],
    ).flatMap((handoff) => handoff.requested_exports),
  ).toEqual([]);

  const typeReexport = await analyzeFixture(
    'export type { Extra } from "./addon.node";',
  );
  expect(typeReexport.summary.native_addon_bindings).toBe(0);
  expect(
    typeReexport.graph.nodes.filter((node) => node.kind === "native-export"),
  ).toEqual([]);
  expect(
    buildJavaScriptNativeHandoffs(
      typeReexport.graph,
      new Set(typeReexport.graph.nodes.map((node) => node.node_id)),
      [],
    ).flatMap((handoff) => handoff.requested_exports),
  ).toEqual([]);

  const mixed = await analyzeFixture(
    'import { type OtherThing, load } from "./addon.node"; load();',
  );
  expect(mixed.summary.native_addon_bindings).toBe(1);
  const mixedExports = mixed.graph.nodes.filter(
    (node) => node.kind === "native-export",
  );
  expect(mixedExports).toHaveLength(1);
  expect(
    mixedExports[0]?.observations[0]?.properties.requested_members,
  ).toEqual(["load"]);
  expect(
    buildJavaScriptNativeHandoffs(
      mixed.graph,
      new Set(mixed.graph.nodes.map((node) => node.node_id)),
      [],
    ).map((handoff) => handoff.requested_exports),
  ).toEqual([["load"]]);

  const value = await analyzeFixture(
    'import { load } from "./addon.node"; load();',
  );
  expect(value.summary.native_addon_bindings).toBe(1);
  expect(
    value.graph.nodes.filter((node) => node.kind === "native-export")[0]
      ?.observations[0]?.properties.requested_members,
  ).toEqual(["load"]);
});

it.each(["node", "NODE", "Node"])(
  "keeps path spelling while classifying .%s native requests",
  async (extension) => {
    const path = `AddOn-É.${extension}`;
    const specifier = `./${path}`;
    const result = await analyzeFixture(
      `import { load } from ${JSON.stringify(specifier)}; load();`,
      path,
    );
    expect(result.statistics.parse_failures).toBe(0);
    expect(result.summary.native_addon_bindings).toBe(
      extension === "node" ? 1 : 0,
    );
    expect(
      result.graph.nodes.filter((node) => node.kind === "native-export"),
    ).toEqual(
      extension === "node"
        ? [
            expect.objectContaining({
              observations: expect.arrayContaining([
                expect.objectContaining({
                  properties: expect.objectContaining({
                    specifier,
                    resolved_path: path,
                    native_export_verification: "not-performed",
                  }),
                }),
              ]),
            }),
          ]
        : [],
    );
    expect(result.graph.edges).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({ specifier, resolved_path: path }),
        evidence: expect.objectContaining({
          extractor: expect.objectContaining({
            operation: "map-static-relationship",
          }),
        }),
      }),
    );
    expect(
      result.graph.nodes
        .filter((node) => node.kind === "native-addon")
        .flatMap((node) => node.observations),
    ).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({ path }),
      }),
    );
  },
);
