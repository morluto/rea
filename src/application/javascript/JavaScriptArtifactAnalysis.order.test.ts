import { expect, it } from "vitest";
import {
  analyzeAndAdoptJavaScriptArtifactFiles,
  javaScriptAnalysisOrder,
} from "./JavaScriptArtifactAnalysis.js";
import { createJavaScriptSemanticGraphProjection } from "./JavaScriptSemanticGraphBuilder.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { err, ok } from "../../domain/result.js";

const source = (path: string): JavaScriptArtifactFile => ({
  path,
  container_sha256: "a".repeat(64),
  sha256: "b".repeat(64),
  bytes: 20,
  inventory_artifact_id: path,
  kind: "javascript",
  unpacked: false,
  text: { included: true, value: "export const x = 1;" },
});

const manifest = (path: string): JavaScriptArtifactFile => ({
  ...source(path),
  kind: "package-json",
  text: { included: true, value: "{}" },
});

// Lexical inventory order puts `node_modules/` before an electron-vite `out-*`
// directory, which is the shape that exhausted the result budget in #9321.
const inventory = [
  source("node_modules/a/index.js"),
  manifest("node_modules/a/package.json"),
  source("node_modules/b/lib/yaml.js"),
  source("out-global-online/main/index.js"),
  source("out-global-online/preload/index.js"),
  manifest("package.json"),
];

it("offers application JavaScript before dependency JavaScript", () => {
  expect(javaScriptAnalysisOrder(inventory).map(({ path }) => path)).toEqual([
    "node_modules/a/package.json",
    "out-global-online/main/index.js",
    "out-global-online/preload/index.js",
    "package.json",
    "node_modules/a/index.js",
    "node_modules/b/lib/yaml.js",
  ]);
  // A package merely named like a dependency directory is not one.
  expect(
    javaScriptAnalysisOrder([
      source("node_modules.js"),
      source("src/node_modules_shim.js"),
    ]).map(({ path }) => path),
  ).toEqual(["node_modules.js", "src/node_modules_shim.js"]);
});

it("spends a limited result budget on first-party sources and keeps inventory order", async () => {
  const javascript = analyzeJavaScriptStaticSource("export const x = 1;");
  const analyzed: string[] = [];
  // Admit two sources, then report the budget as spent, as the parent does
  // once its remaining result capacity is reserved for static observations.
  const worker = {
    analyze: async (file: JavaScriptArtifactFile) => {
      analyzed.push(file.path);
      const value = { javascript, module: null, projection: null };
      if (analyzed.length <= 2) return ok(value);
      return err({
        ...value,
        error: new AnalysisResourceConstraintError(
          "analyze_javascript_application",
          "memory",
          `semantic analysis of ${file.path} was not started`,
          { semantic_result_budget_bytes: 0 },
        ),
      });
    },
  };
  const outcome = await analyzeAndAdoptJavaScriptArtifactFiles(
    {
      files: inventory,
      unavailable_relevant_files: [],
      containers: [],
      text_bytes_read: 120,
      invalid_utf8_files: 0,
    },
    worker,
    createJavaScriptSemanticGraphProjection(),
    async () => {},
  );
  expect(analyzed).toEqual([
    "out-global-online/main/index.js",
    "out-global-online/preload/index.js",
    "node_modules/a/index.js",
    "node_modules/b/lib/yaml.js",
  ]);
  expect(outcome.analysis.files.map(({ file }) => file.path)).toEqual(
    inventory.map(({ path }) => path),
  );
  const failed = outcome.analysis.files
    .filter(({ analysis_failure }) => analysis_failure !== undefined)
    .map(({ file }) => file.path);
  expect(failed).toEqual([
    "node_modules/a/index.js",
    "node_modules/b/lib/yaml.js",
  ]);
  expect(outcome.interruption).toBeNull();
});

it("spends capacity in the caller's requested order for explicitly selected sources", async () => {
  const files = [
    source("node_modules/selected/index.js"),
    source("src/main.js"),
  ];
  const admitted: string[] = [];
  const javascript = analyzeJavaScriptStaticSource("export const x = 1;");
  const outcome = await analyzeAndAdoptJavaScriptArtifactFiles(
    {
      files,
      unavailable_relevant_files: [],
      containers: [],
      text_bytes_read: 40,
      invalid_utf8_files: 0,
      source_selection: {
        requested_paths: files.map((file) => file.path),
        unselected_files: 0,
      },
    },
    {
      analyze: async (file) => {
        const value = { javascript, module: null, projection: null };
        admitted.push(file.path);
        return admitted.length === 1
          ? ok(value)
          : err({
              ...value,
              error: new AnalysisResourceConstraintError(
                "analyze_javascript_application",
                "memory",
                "result capacity exhausted",
                { semantic_result_budget_bytes: 0 },
              ),
            });
      },
    },
    createJavaScriptSemanticGraphProjection(),
    async () => {},
  );
  expect(admitted).toEqual(files.map((file) => file.path));
  expect(
    outcome.analysis.files.find(({ file }) => file.path === files[0]!.path)
      ?.analysis_failure,
  ).toBeUndefined();
  expect(
    outcome.analysis.files.find(({ file }) => file.path === files[1]!.path)
      ?.analysis_failure,
  ).toBeDefined();
});
