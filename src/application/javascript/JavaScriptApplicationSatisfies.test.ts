import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import { analyzeJavaScriptSemantics } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import { topLevelBinding } from "../../domain/javascript/javascriptSemanticAnalysis.fixture.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

it.each([
  '"ready" satisfies string',
  '("ready" satisfies string) as string',
  '("ready" satisfies string)!',
])("retains the runtime primitive through %s", (expression) => {
  const ir = analyzeJavaScriptSemantics(`const value = ${expression};`);
  expect(topLevelBinding(ir, "value").value).toEqual({
    status: "literal",
    value: "ready",
  });
});

it("retains exported constant evidence through a type-only satisfies expression", async () => {
  const root = await createTestTempDirectory("rea-ts-satisfies-");
  await writeFile(
    join(root, "app.ts"),
    'export const value = "ready" satisfies string;\n',
  );
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
      ({ kind, properties }) =>
        kind === "literal" && properties.value === "ready",
    ),
  ).toHaveLength(1);
});

it("retains local call targets and exported callable links through satisfies", () => {
  const ir = analyzeJavaScriptSemantics(
    'export const render = (() => "ready") satisfies (() => string); render();',
  );
  const callable = ir.callables[0];
  if (callable === undefined) throw new Error("Missing callable");
  expect(
    ir.moduleLinks.find(({ localName }) => localName === "render")?.callableId,
  ).toBe(callable.callableId);
  expect(ir.callSites[0]?.calleeCallableIds).toEqual([callable.callableId]);
  expect(ir.callSites[0]?.resolution).toBe("exact");
});
