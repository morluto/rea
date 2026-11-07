import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { scanCanonicalArtifactInventory } from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { readJavaScriptArtifactFiles } from "../../support/javascriptApplicationScope.js";
import {
  analyzeAndAdoptJavaScriptArtifactFiles,
  analyzeJavaScriptArtifactFiles,
} from "../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import {
  buildImmutableJavaScriptArtifactGraphSteps,
  buildJavaScriptArtifactGraph,
} from "../../../src/application/javascript/JavaScriptArtifactGraphBuilder.js";
import { createJavaScriptSemanticGraphProjection } from "../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { createJavaScriptArtifactReader } from "../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import type {
  JavaScriptJsonModuleObservation,
  JavaScriptPackageObservation,
  JavaScriptSourceMapObservation,
} from "../../../src/application/javascript/JavaScriptArtifactAnalysisTypes.js";

it("keeps per-file failure reasons in the graph while summarizing them globally", async () => {
  const root = await createTestTempDirectory("rea-artifact-failure-summary-");
  await Promise.all([
    writeFile(join(root, "one.js"), "x"),
    writeFile(join(root, "two.js"), "x"),
  ]);
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const outcome = await analyzeAndAdoptJavaScriptArtifactFiles(
      files,
      {
        analyze: async (file) =>
          err({
            error: new AnalysisResourceConstraintError(
              "analyze",
              "memory",
              `failure for ${file.path}`,
              null,
            ),
            javascript: null,
            module: null,
            projection: null,
          }),
      },
      createJavaScriptSemanticGraphProjection(),
      async () => {},
    );
    const graph = buildJavaScriptArtifactGraph(
      snapshot,
      files,
      outcome.analysis,
    );
    expect(outcome.analysis.limitations).toHaveLength(3);
    const observations = graph.nodes
      .filter(({ kind }) => kind === "unknown")
      .flatMap(({ observations }) => observations);
    for (const path of ["one.js", "two.js"])
      expect(observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              path,
              limitation: expect.stringContaining(`failure for ${path}`),
            }),
          }),
        ]),
      );
    const available = Buffer.byteLength(JSON.stringify(graph)) + 1024;
    const admission = () => {
      let remaining = available;
      return {
        remainingBytes: () => remaining,
        reserveBytes: (bytes: number) => {
          if (bytes > remaining) return false;
          remaining -= bytes;
          return true;
        },
        releaseBytes: (bytes: number) => {
          remaining += bytes;
        },
      };
    };
    const complete = buildImmutableJavaScriptArtifactGraphSteps(
      snapshot,
      files,
      outcome.analysis,
      admission(),
    );
    while (!complete.next().done) {
      /* drain the cooperative graph */
    }
    const enlarged = {
      ...outcome.analysis,
      files: outcome.analysis.files.map((file) =>
        file.analysis_failure === undefined
          ? file
          : {
              ...file,
              analysis_failure: {
                ...file.analysis_failure,
                reason: "failure ".repeat(2000),
              },
            },
      ),
    };
    const limited = buildImmutableJavaScriptArtifactGraphSteps(
      snapshot,
      files,
      enlarged,
      admission(),
    );
    expect(() => {
      while (!limited.next().done) {
        /* drain until refused */
      }
    }).toThrow(/Evidence budget/u);
  } finally {
    await reader.close();
  }
});

it("uses the first structured observation when paths repeat", async () => {
  const root = await createTestTempDirectory("rea-artifact-graph-index-");
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" })),
    writeFile(join(root, "data.json"), JSON.stringify({ actual: true })),
    writeFile(join(root, "app.js"), "//# sourceMappingURL=app.js.map"),
    writeFile(
      join(root, "app.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["app.ts"],
        names: [],
        mappings: "",
      }),
    ),
  ]);
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const packageObservation = analysis.packages.find(
      ({ path }) => path === "package.json",
    );
    const jsonObservation = analysis.json_modules.find(
      ({ path }) => path === "data.json",
    );
    const sourceMapObservation = analysis.source_maps.find(
      ({ path }) => path === "app.js.map",
    );
    expect(packageObservation).toBeDefined();
    expect(jsonObservation).toBeDefined();
    expect(sourceMapObservation).toBeDefined();
    if (
      packageObservation === undefined ||
      jsonObservation === undefined ||
      sourceMapObservation === undefined
    )
      throw new TypeError("Expected structured artifact observations");

    const graph = buildJavaScriptArtifactGraph(snapshot, files, {
      ...analysis,
      packages: [
        packageObservation,
        {
          ...packageObservation,
          status: "invalid",
          name: null,
          version: null,
          main: null,
          renderer: null,
          limitation: "later duplicate",
        } satisfies JavaScriptPackageObservation,
      ],
      json_modules: [
        jsonObservation,
        {
          ...jsonObservation,
          status: "invalid",
          top_level_keys: [],
          omitted_top_level_keys: 0,
          limitation: "later duplicate",
        } satisfies JavaScriptJsonModuleObservation,
      ],
      source_maps: [
        sourceMapObservation,
        {
          ...sourceMapObservation,
          status: "invalid",
          sources: [],
          limitation: "later duplicate",
        } satisfies JavaScriptSourceMapObservation,
      ],
    });

    const dataFile = graph.nodes.find(({ observations }) =>
      observations.some(({ properties }) => properties.path === "data.json"),
    );
    expect(dataFile?.observations[0]?.properties).toMatchObject({
      json_parse_status: "included",
      json_top_level_keys: ["actual"],
      omitted_json_top_level_keys: 0,
    });
    const unavailablePaths = graph.nodes
      .filter(({ kind }) => kind === "unknown")
      .flatMap(({ observations }) =>
        observations.map(({ properties }) => ({
          path: properties.path,
          operation: properties.operation,
        })),
      );
    expect(unavailablePaths).not.toContainEqual({
      path: "package.json",
      operation: "parse-package-json",
    });
    expect(unavailablePaths).not.toContainEqual({
      path: "data.json",
      operation: "parse-json-module",
    });
    expect(unavailablePaths).not.toContainEqual({
      path: "app.js.map",
      operation: "parse-local-source-map",
    });
  } finally {
    await reader.close();
  }
});
