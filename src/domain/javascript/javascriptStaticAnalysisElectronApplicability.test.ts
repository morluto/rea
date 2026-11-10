import { describe, expect, it } from "vitest";

import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

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

  it.each([`import "electron";`, `import("electron");`])(
    "recognizes Electron module loads: %s",
    (source) => {
      expect(
        analyzeJavaScriptStaticSource(source).analysis_coverage?.applicability
          .electron,
      ).toBe("observed");
    },
  );

  it("observes a require load with proven CommonJS authority", () => {
    const source = 'require("electron");';
    const file = parseJavaScriptSource(source, "main.cjs");
    if (file === null) throw new Error("expected a parsed CommonJS fixture");
    expect(
      analyzeParsedJavaScriptStaticSource(source, file).analysis_coverage
        ?.applicability.electron,
    ).toBe("observed");
  });

  it("keeps an unproved require loader conditional", () => {
    const analysis = analyzeJavaScriptStaticSource('require("electron");');
    expect(analysis.references).toContainEqual(
      expect.objectContaining({
        specifier: "electron",
        loader_authority: "candidate",
      }),
    );
    expect(analysis.analysis_coverage?.applicability.electron).toBe("unknown");
  });

  it("retains a resolution reference without observing an Electron load", () => {
    const analysis = analyzeJavaScriptStaticSource(
      'require.resolve("electron");',
    );
    expect(analysis.references).toContainEqual(
      expect.objectContaining({ specifier: "electron", operation: "resolve" }),
    );
    expect(analysis.analysis_coverage?.applicability.electron).toBe("unknown");
  });
});
