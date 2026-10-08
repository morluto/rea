import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { reconstructJavaScriptArtifact } from "../../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import {
  analyzeJavaScriptArtifactFiles,
  analyzeAndProjectJavaScriptArtifactFiles,
} from "../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { buildJavaScriptArtifactGraph } from "../../../src/application/javascript/JavaScriptArtifactGraphBuilder.js";
import {
  buildJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphProjection,
} from "../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import { createJavaScriptArtifactReader } from "../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import { readJavaScriptArtifactFiles } from "../../../src/artifacts/javascript/JavaScriptArtifactFiles.js";
import { scanCanonicalArtifactInventory } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { scanArtifactInventory } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { parseJavaScriptApplicationGraph } from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createJavaScriptSemanticGraph } from "../../../src/domain/javascript/javascriptSemanticGraph.js";
import { parseJavaScriptSemanticGraph } from "../../../src/domain/javascript/javascriptSemanticGraphSerialization.js";
import { writeJavaScriptArtifactFixture } from "../../fixtures/javascriptArtifactApplication.js";

it("reports file progress and honors cancellation before the next source", async () => {
  const root = await fixtureDirectory();
  const controller = new AbortController();
  const progress: string[] = [];
  await expect(
    reconstructJavaScriptArtifact({ input_path: root }, controller.signal, {
      report: async (event) => {
        if (event.phase === "parse_javascript_source") {
          progress.push(event.message);
          if (progress.length === 2) controller.abort();
        }
      },
    }),
  ).rejects.toMatchObject({ reason: "cancelled" });
  expect(progress).toHaveLength(2);
  expect(progress[0]).not.toBe(progress[1]);
});

it("preserves graph commitments and export shapes when consuming file-local IR", async () => {
  const root = await fixtureDirectory();
  await writeFile(
    join(root, "exports.mjs"),
    `
    import { readFile } from "node:fs";
    export { readFile as read };
    export function create(value) { return { value, nested: { enabled: true } }; }
    function unexported() { return "private"; }
  `,
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const full = analyzeJavaScriptArtifactFiles(files);
    const projection = createJavaScriptSemanticGraphProjection();
    const compact = await analyzeAndProjectJavaScriptArtifactFiles(
      files,
      projection.projectFile,
    );
    const graph = buildJavaScriptArtifactGraph(snapshot, files, full);
    expect(buildJavaScriptArtifactGraph(snapshot, files, compact)).toEqual(
      graph,
    );
    const semantic = projection.finish(
      snapshot.manifest.root_sha256,
      graph,
      compact,
    );
    expect(semantic).toEqual(
      buildJavaScriptSemanticGraph({
        rootArtifactSha256: snapshot.manifest.root_sha256,
        applicationGraph: graph,
        analysis: full,
      }),
    );
    expect(
      semantic.nodes.some(
        ({ application_node_ids }) => application_node_ids.length > 0,
      ),
    ).toBe(true);
    const exported = compact.files.find(
      ({ file }) => file.path === "exports.mjs",
    );
    expect(exported?.semantic?.ir.callables.map(({ name }) => name)).toEqual([
      "create",
    ]);
    expect(
      full.files
        .find(({ file }) => file.path === "exports.mjs")
        ?.semantic?.ir.callables.map(({ name }) => name),
    ).toContain("unexported");
    expect(parseJavaScriptSemanticGraph(semantic)).toEqual(semantic);
  } finally {
    await reader.close();
  }
});

it("reconstructs package, Electron roles, Webpack/Rspack modules, and cross-layer facts without execution", async () => {
  const root = await fixtureDirectory();
  Reflect.deleteProperty(globalThis, "__rea_bundle_executed");

  const result = await reconstructJavaScriptArtifact({
    input_path: root,
  });
  const graph = parseJavaScriptApplicationGraph(result.graph);
  const semanticGraph = parseJavaScriptSemanticGraph(result.semantic_graph);

  expect(Reflect.get(globalThis, "__rea_bundle_executed")).toBeUndefined();
  expect(result.input_path).toBe(root);
  expect(result.statistics).toMatchObject({
    modules: 4,
    parse_failures: 0,
    relevant_files: expect.any(Number),
    text_bytes_read: expect.any(Number),
  });
  expect(graph.nodes.map(({ kind }) => kind)).toEqual(
    expect.arrayContaining([
      "package",
      "artifact",
      "electron-main",
      "electron-preload",
      "electron-renderer",
      "javascript-asset",
      "javascript-chunk",
      "javascript-module",
      "worker",
      "service-worker",
      "endpoint",
      "storage",
      "source-map",
      "source-module",
      "native-addon",
    ]),
  );
  expect(graph.nodes.filter(({ kind }) => kind === "javascript-chunk")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ bundler: "webpack" }),
          }),
        ]),
      }),
      expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ bundler: "rspack" }),
          }),
        ]),
      }),
    ]),
  );
  expect(
    graph.nodes.filter(({ kind }) => kind === "javascript-module"),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              module_key: "1",
              structural_fingerprint_algorithm: "babel-ast-v1",
            }),
          }),
        ]),
      }),
    ]),
  );
  expect(graph.edges.map(({ relation }) => relation)).toEqual(
    expect.arrayContaining([
      "contains",
      "loads",
      "imports",
      "maps_to",
      "exposes",
      "calls",
      "persists_to",
    ]),
  );
  assertSemanticLinks(result, graph, semanticGraph);
});

it("produces deterministic ASAR graphs with unpacked native linkage and complete paths/digests", async () => {
  const root = await createTestTempDirectory("rea-javascript-asar-");
  const source = join(root, "source");
  await mkdir(source);
  await writeJavaScriptArtifactFixture(source);
  const archive = join(root, "app.asar");
  await createPackageWithOptions(source, archive, { unpack: "**/*.node" });

  const first = await reconstructJavaScriptArtifact({
    input_path: archive,
    format: "asar",
  });
  const second = await reconstructJavaScriptArtifact({
    input_path: archive,
    format: "asar",
  });

  expect(first.graph).toEqual(second.graph);
  expect(first.inventory_graph_sha256).toBe(second.inventory_graph_sha256);
  expect(first.graph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "asar-entry",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              entry_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
              inventory_artifact_id:
                expect.stringMatching(/^art_[a-f0-9]{64}$/u),
            }),
          }),
        ]),
      }),
      expect.objectContaining({
        kind: "native-addon",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              path: "native/addon.node",
              unpacked: true,
            }),
          }),
        ]),
      }),
    ]),
  );
  expect(first.graph.edges).toContainEqual(
    expect.objectContaining({
      relation: "loads",
      properties: expect.objectContaining({
        resolved_path: "native/addon.node",
      }),
    }),
  );
});

it("keeps suffix-named ASAR directories in the graph and analyzes their files", async () => {
  const root = await createTestTempDirectory(
    "rea-javascript-asar-suffix-directory-",
  );
  const source = join(root, "source");
  const zipDirectory = join(source, "node_modules", "@zip.js");
  await mkdir(zipDirectory, { recursive: true });
  await writeJavaScriptArtifactFixture(source);
  await writeFile(
    join(zipDirectory, "entry.js"),
    "export const packed = true;\n",
  );
  const archive = join(root, "app.asar");
  await createPackageWithOptions(source, archive, {});

  const snapshot = await scanArtifactInventory(archive);
  const zipDirectoryOccurrence = snapshot.occurrences.find(
    ({ logical_path }) => logical_path === "node_modules/@zip.js",
  );
  expect(zipDirectoryOccurrence).toMatchObject({
    entry_kind: "directory",
    artifact_id: expect.stringMatching(/^art_[a-f0-9]{64}$/u),
  });
  expect(
    snapshot.nodes.some(
      ({ artifact_id }) => artifact_id === zipDirectoryOccurrence?.artifact_id,
    ),
  ).toBe(true);

  await reconstructAsarArchive(archive, [
    expect.objectContaining({
      kind: "javascript-asset",
      observations: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            path: "node_modules/@zip.js/entry.js",
          }),
        }),
      ]),
    }),
  ]);
});

it("keeps ASAR analysis usable when unpacked native companion bytes are absent", async () => {
  const root = await createTestTempDirectory("rea-javascript-asar-missing-");
  const source = join(root, "source");
  await mkdir(source);
  await writeJavaScriptArtifactFixture(source);
  const archive = join(root, "app.asar");
  await createPackageWithOptions(source, archive, { unpack: "**/*.node" });
  await rm(join(`${archive}.unpacked`, "native", "addon.node"));

  const snapshot = await scanArtifactInventory(archive);
  const missingNative = snapshot.occurrences.find(
    ({ logical_path }) => logical_path === "native/addon.node",
  );

  expect(missingNative).toMatchObject({
    artifact_id: null,
    hash_status: "unavailable",
    limitations: expect.arrayContaining([
      "ASAR unpacked companion bytes were unavailable; no content hash or child artifact was produced.",
    ]),
  });

  await reconstructAsarArchive(archive, [
    expect.objectContaining({ kind: "javascript-asset" }),
  ]);
});

it("recurses into filesystem-backed ASAR containers without losing container-relative paths", async () => {
  const root = await createTestTempDirectory("rea-javascript-nested-asar-");
  const source = await fixtureDirectory();
  const outer = join(root, "outer");
  const resources = join(outer, "resources");
  await mkdir(resources, { recursive: true });
  await createPackageWithOptions(source, join(resources, "app.asar"), {
    unpack: "**/*.node",
  });

  const result = await reconstructJavaScriptArtifact({
    input_path: outer,
  });

  expect(result.statistics.nested_asar_containers).toBe(1);
  expect(result.statistics.modules).toBe(4);
  expect(result.graph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "artifact",
        observations: expect.arrayContaining([
          expect.objectContaining({
            label: "resources/app.asar",
            properties: expect.objectContaining({ format: "asar" }),
          }),
        ]),
      }),
      expect.objectContaining({
        kind: "javascript-asset",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              path: "resources/app.asar/main.js",
            }),
          }),
        ]),
      }),
    ]),
  );
});

const assertSemanticLinks = (
  result: Awaited<ReturnType<typeof reconstructJavaScriptArtifact>>,
  graph: ReturnType<typeof parseJavaScriptApplicationGraph>,
  semanticGraph: ReturnType<typeof parseJavaScriptSemanticGraph>,
) => {
  expect(semanticGraph.application_graph_id).toBe(graph.graph_id);
  const { graph_id: _semanticGraphId, ...semanticGraphInput } = semanticGraph;
  const mismatchedSemanticGraph = createJavaScriptSemanticGraph({
    ...semanticGraphInput,
    application_graph_id: `jag_${"f".repeat(64)}`,
  });
  const { electron_summary: summary, ...analysisResult } = result;
  expect(() =>
    javascriptApplicationAnalysisResultSchema.parse({
      ...analysisResult,
      summary,
      semantic_graph: mismatchedSemanticGraph,
    }),
  ).toThrow(/must commit the containing application graph/u);
  expect(
    semanticGraph.nodes.some(
      ({ application_node_ids: identifiers }) => identifiers.length > 0,
    ),
  ).toBe(true);
  expect(semanticGraph.relations.length).toBeGreaterThan(0);
  const roles = ["electron-main", "electron-preload"].map((kind) =>
    graph.nodes.find((node) => node.kind === kind),
  );
  expect(roles[0]?.observations[0]?.properties).toMatchObject({
    declared_path: "main.js",
    resolution_context: "package-entrypoint",
    resolved_path: "main.js",
    resolution_status: "resolved",
    limitations: [],
  });
  expect(roles[1]?.observations[0]?.properties).toMatchObject({
    declared_path: "preload.js",
    resolution_context: "filesystem-expression",
    resolved_path: "preload.js",
    resolution_status: "resolved",
    limitations: [],
  });
  const mainAsset = graph.nodes.find(
    (node) =>
      node.kind === "javascript-asset" &&
      node.observations.some(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "artifact-path" &&
          evidence.location.value.path === "main.js",
      ),
  );
  if (mainAsset === undefined)
    throw new Error("Expected main JavaScript asset");
  const mainSemanticNodes = semanticGraph.nodes.filter(
    ({ identity }) => identity.module_path === "main.js",
  );
  const linkedMainSemanticNodes = mainSemanticNodes.filter(
    ({ application_node_ids: identifiers }) =>
      identifiers.includes(mainAsset.node_id),
  );
  expect(linkedMainSemanticNodes.length).toBeGreaterThan(0);
  expect(linkedMainSemanticNodes.length).toBeLessThan(mainSemanticNodes.length);
  for (const role of roles) {
    expect(role).toBeDefined();
    expect(
      graph.edges.some(
        (edge) =>
          edge.source_node_id === role?.node_id && edge.relation === "maps_to",
      ),
    ).toBe(true);
  }
  const endpointJson = JSON.stringify(
    graph.nodes.filter(({ kind }) => kind === "endpoint"),
  );
  expect(endpointJson).toContain("token=fixture-secret");
};

const reconstructAsarArchive = async (
  archive: string,
  expectedNodes: readonly unknown[],
): Promise<Awaited<ReturnType<typeof reconstructJavaScriptArtifact>>> => {
  const result = await reconstructJavaScriptArtifact({
    input_path: archive,
    format: "asar",
  });
  expect(result.statistics.parsed_javascript_files).toBeGreaterThan(0);
  expect(result.graph.nodes).toEqual(
    expect.arrayContaining([...expectedNodes]),
  );
  return result;
};

const fixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-javascript-artifact-");
  await writeJavaScriptArtifactFixture(root);
  return root;
};

for (const extension of ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"]) {
  it.each(["directory", "asar"] as const)(
    `retains ${extension} source facts from a real %s artifact`,
    async (format) => {
      const root = await createTestTempDirectory("rea-nodenext-artifacts-");
      const directory = join(root, "source");
      await mkdir(directory);
      const path = `selected.${extension}`;
      const parameter = ["ts", "tsx", "mts", "cts"].includes(extension)
        ? "value: string"
        : "value";
      const source = `
        globalThis.__rea_nodenext_executed = true;
        throw new Error("fixture must remain inert");
        export function selected_feature(${parameter}) { return { value }; }
      `;
      await writeFile(join(directory, path), source);
      let inputPath = directory;
      if (format === "asar") {
        inputPath = join(root, "application.asar");
        await createPackageWithOptions(directory, inputPath, {});
      }
      Reflect.deleteProperty(globalThis, "__rea_nodenext_executed");
      const result = await reconstructJavaScriptArtifact({
        input_path: inputPath,
        format,
      });
      expect(Reflect.get(globalThis, "__rea_nodenext_executed")).toBeUndefined();
      expect(result.statistics).toMatchObject({
        relevant_files: 1,
        parsed_javascript_files: 1,
        text_bytes_read: Buffer.byteLength(source),
        parse_failures: 0,
      });
      const asset = result.graph.nodes.find(
        ({ kind, observations }) =>
          kind === "javascript-asset" &&
          observations.some(({ properties }) => properties.path === path),
      );
      expect(asset?.identity).toMatchObject({
        sha256: createHash("sha256").update(source).digest("hex"),
      });
      expect(asset?.observations[0]?.properties).toMatchObject({
        path,
        bytes: Buffer.byteLength(source),
        file_kind: "javascript",
        parse_status: "complete",
      });
      expect(
        result.semantic_graph.nodes.some(
          ({ identity }) => identity.module_path === path,
        ),
      ).toBe(true);
      expect(result.graph.coverage).toMatchObject({
        status: "complete",
        truncated: false,
      });
    },
  );
}
