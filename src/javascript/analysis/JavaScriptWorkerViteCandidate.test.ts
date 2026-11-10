import { expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "../../domain/javascript/javascriptStaticAnalysis.js";
import { javaScriptWorkerStaticAnalysisSchema } from "./JavaScriptAnalysisWorkerSchemas.js";

it("admits Vite table candidates only with their candidate operation", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const __vite__mapDeps = (i, m = __vite__mapDeps,
      d = (m.f || (m.f = ["./lazy.js"]))) => i.map(i => d[i]);
    __vite__mapDeps([0]);
  `);
  expect(javaScriptWorkerStaticAnalysisSchema.safeParse(analysis).success).toBe(
    true,
  );
  expect(
    javaScriptWorkerStaticAnalysisSchema.safeParse({
      ...analysis,
      references: analysis.references.map((reference) => ({
        ...reference,
        operation: "load",
      })),
    }).success,
  ).toBe(false);
});
