import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("Electron applicability", () => {
  it("does not treat Vite table candidates or worker paths as module references", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const __vite__mapDeps = (i, m = __vite__mapDeps,
        d = m.f || (m.f = ["electron"])) => i.map(n => d[n]);
      __vite__mapDeps([0]);
      new Worker(new URL("electron", import.meta.url));
    `);
    expect(analysis.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "vite-table-candidate",
          specifier: "electron",
        }),
        expect.objectContaining({ kind: "worker", specifier: "electron" }),
      ]),
    );
    expect(analysis.analysis_coverage?.applicability.electron).toBe("unknown");
  });

  it.each([
    `import "electron";`,
    `import("electron");`,
    `require("electron");`,
    `require.resolve("electron");`,
  ])("recognizes actual Electron module references: %s", (source) => {
    expect(
      analyzeJavaScriptStaticSource(source).analysis_coverage?.applicability
        .electron,
    ).toBe("observed");
  });
});
