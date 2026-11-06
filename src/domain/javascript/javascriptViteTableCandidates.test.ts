import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const source = (consumer: string) => `
const __vite__mapDeps = (i, m = __vite__mapDeps,
  d = (m.f || (m.f = ["./lazy.css"]))) => i.map(i => d[i]);
${consumer}
`;

it("retains the literal table value as a candidate, not a proven import", () => {
  const analysis = analyzeJavaScriptStaticSource(
    source(`
    const helper = deps => deps.map(dep => "https://elsewhere.test/file.css");
    helper(__vite__mapDeps([0]));
    import("./actual.js");
    import("vite-output:assets/lazy.js");
  `),
  );
  expect(analysis.references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        specifier: "./lazy.css",
        kind: "vite-table-candidate",
        operation: "candidate",
      }),
      expect.objectContaining({
        specifier: "./actual.js",
        kind: "dynamic-import",
      }),
    ]),
  );
  const actual = analysis.references.find(
    (item) => item.specifier === "./actual.js",
  );
  expect(actual?.operation).toBe("load");
  expect(
    analysis.references.find(
      (item) => item.specifier === "vite-output:assets/lazy.js",
    ),
  ).toMatchObject({
    kind: "dynamic-import",
    operation: "load",
  });
  expect(
    analysis.analysis_coverage?.semantics.unknown_findings,
  ).toBeGreaterThan(0);
});
