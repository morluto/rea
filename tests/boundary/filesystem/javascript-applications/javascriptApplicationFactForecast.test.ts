import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { completeJavaScriptAnalysisSteps } from "../../../../src/application/javascript/JavaScriptAnalysisControl.js";
import { estimateJavaScriptModuleApplicationProjection } from "../../../../src/domain/javascript/javascriptApplicationProjectionResources.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { projectJavaScriptModuleSemantics } from "../../../../src/domain/javascript/javascriptModuleSemanticIr.js";
import { moduleResolutionModeForJavaScriptReference } from "../../../../src/domain/javascript/javascriptModuleResolutionMode.js";
import { analyzeParsedJavaScriptSemanticsSteps } from "../../../../src/domain/javascript/javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "../../../../src/domain/javascript/javascriptSourceParser.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptApplication } from "../../../support/javascriptApplicationScope.js";

// Records the source-module, export and module-relationship projection emits.
const MODULE_OPERATIONS = new Set([
  "recover-source-module",
  "recover-module-export",
  "recover-export-return-shapes",
  "expose-module-export",
  "resolve-semantic-module-relationship",
  "retain-unresolved-semantic-module",
]);

const exports = Array.from(
  { length: 40 },
  (_, index) =>
    `export function method_${String(index)}(input) { const value = input + ${String(index)}; if (input) return { value, nested: { list: [value, "x"] } }; return value; }`,
).join("\n");

it.each([
  ["many exported return shapes", "a-large.mjs", exports],
  [
    "imports, re-exports and a long non-ASCII path",
    "dir/sub/ü-módulo with spaces.mjs",
    `import a from "missing-pkg"; import { b } from "./other.mjs"; export { b }; export * from "./x.mjs"; export { c as d } from "nope"; export default function () { return { a: 1, b: [1, 2], c: { d: "x" } }; } export const e = () => ({ deep: { deeper: { deepest: [1, "two", null] } } }); export class F {}\n`,
  ],
  [
    "CommonJS exports",
    "lib/index.cjs",
    `const dep = require("./dep.cjs"); exports.alpha = function () { return dep; }; module.exports.beta = () => 2; exports.gamma = { x: 1 };\n`,
  ],
])(
  "forecasts at least the application bytes emitted for %s",
  { timeout: 60_000 },
  async (_shape, path, text) => {
    const root = await createTestTempDirectory("rea-js-application-forecast-");
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
    const parsed = parseJavaScriptSource(text, path);
    if (parsed === null) throw new Error("fixture should parse");
    const module = projectJavaScriptModuleSemantics(
      await completeJavaScriptAnalysisSteps(
        analyzeParsedJavaScriptSemanticsSteps(
          parsed,
          moduleResolutionModeForJavaScriptReference(path, "static-import"),
        ),
      ),
    );
    const result = await analyzeJavaScriptApplication({ input_path: root });
    if (!result.ok) throw result.error;
    const { graph } = javascriptApplicationAnalysisResultSchema.parse(
      result.value.normalized_result,
    );
    const emitted = (value: object) =>
      Buffer.byteLength(JSON.stringify(value)) + 1;
    const sourceModules = new Set<string>();
    let bytes = 0;
    for (const node of graph.nodes)
      if (
        node.observations.some(({ evidence }) =>
          MODULE_OPERATIONS.has(evidence.extractor.operation),
        )
      ) {
        bytes += emitted(node);
        if (
          node.observations.some(
            ({ properties }) => properties.semantic_role === "source-module",
          )
        )
          sourceModules.add(node.node_id);
      }
    for (const edge of graph.edges)
      if (
        MODULE_OPERATIONS.has(edge.evidence.extractor.operation) ||
        (edge.relation === "contains" && sourceModules.has(edge.target_node_id))
      )
        bytes += emitted(edge);
    expect(sourceModules.size).toBe(1);
    const forecast = estimateJavaScriptModuleApplicationProjection(
      module,
      path,
    );
    expect(forecast.bytes).toBeGreaterThanOrEqual(bytes);
    // Over-reservation refused modules whose facts fit the Evidence budget.
    expect(forecast.bytes).toBeLessThan(bytes * 2.5);
  },
);
