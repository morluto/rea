import { expect, it } from "vitest";
import { javaScriptAnalysisResourceControlsSchema } from "./javascriptAnalysisResourceControls.js";

it("keeps omitted operational choices absent and validates explicit semantic budgets", () => {
  expect(javaScriptAnalysisResourceControlsSchema.parse({})).toEqual({});
  expect(
    javaScriptAnalysisResourceControlsSchema.parse({
      max_semantic_nodes: 750_000,
      max_semantic_nodes_per_file: 700_000,
    }),
  ).toEqual({
    max_semantic_nodes: 750_000,
    max_semantic_nodes_per_file: 700_000,
  });
  for (const value of [0, -1, 1.5, 1_000_001, Infinity, NaN]) {
    for (const key of ["max_semantic_nodes", "max_semantic_nodes_per_file"])
      expect(
        javaScriptAnalysisResourceControlsSchema.safeParse({ [key]: value })
          .success,
      ).toBe(false);
  }
});
