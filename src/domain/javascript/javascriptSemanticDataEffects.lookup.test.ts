import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it("keeps defaults linked to their own config reads across a large source", () => {
  const count = 400;
  const source = Array.from(
    { length: count },
    (_, index) =>
      `const value${index} = process.env.KEY_${index} ?? "fallback-${index}";`,
  ).join("\n");

  const operations = analyzeJavaScriptSemantics(source).configurationOperations;
  const defaults = operations.filter(({ kind }) => kind === "default");

  expect(defaults).toHaveLength(count);
  for (let index = 0; index < count; index += 1) {
    expect(defaults.find(({ key }) => key === `KEY_${index}`)).toMatchObject({
      key: `KEY_${index}`,
      value: `fallback-${index}`,
    });
  }
});
