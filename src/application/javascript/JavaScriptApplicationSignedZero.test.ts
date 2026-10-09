import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

it("does not expose a resolved positive-zero literal for a negative-zero export", async () => {
  const root = await createTestTempDirectory("rea-signed-zero-");
  await writeFile(join(root, "app.js"), "export const value = -0;\n");
  const result = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!result.ok) throw result.error;
  const analysis = javascriptApplicationAnalysisResultSchema.parse(
    result.value.normalized_result,
  );
  expect(
    analysis.semantic_graph.nodes.filter(
      ({ kind, properties }) => kind === "literal" && properties.value === 0,
    ),
  ).toEqual([]);
});
