import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import {
  bomSourceCases,
  createBomArtifact,
  expectBomSourceRange,
} from "../../fixtures/javascriptArtifactBom.js";

for (const format of ["directory", "asar"] as const) {
  for (const fixture of bomSourceCases) {
    for (const prefix of ["", "\uFEFF"] as const) {
      it(`${format} preserves ${fixture.kind} original ranges with ${prefix === "" ? "no BOM" : "a UTF-8 BOM"}`, async () => {
        const source =
          fixture.kind === "html"
            ? `${prefix}${fixture.source}`
            : `${prefix}${fixture.source}\nglobalThis.__rea_bom_executed = true; throw new Error("must remain inert");`;
        const bytes = Buffer.from(source);
        const input = await createBomArtifact(format, {
          [fixture.path]: bytes,
          "dep.js": "export const dependency = true;",
        });
        const result = await reconstructJavaScriptArtifact({
          input_path: input,
        });
        expect(result.statistics).toMatchObject({
          parse_failures: 0,
          invalid_utf8_files: 0,
        });
        expect(Reflect.get(globalThis, "__rea_bom_executed")).toBeUndefined();
        expectBomSourceRange(result.graph, fixture, bytes);
      });
    }
  }

  it(`${format} preserves accepted BOM handling for package, JSON and source maps`, async () => {
    const input = await createBomArtifact(format, {
      "package.json": '\uFEFF{"name":"bom-package","main":"dep.js"}',
      "data.json": '\uFEFF{"__proto__":"owned","control":true}',
      "app.js.map":
        '\uFEFF{"version":3,"sources":["original.js"],"sourcesContent":["export const original = true;"],"names":[],"mappings":"AAAA"}',
      "dep.js": "export const dependency = true;",
    });
    const result = await reconstructJavaScriptArtifact({ input_path: input });
    expect(result.statistics).toMatchObject({
      parse_failures: 0,
      invalid_utf8_files: 0,
    });
    const observations = result.graph.nodes.flatMap(
      ({ observations }) => observations,
    );
    expect(
      observations.some(
        ({ properties }) =>
          properties.name === "bom-package" &&
          properties.parse_status === "included",
      ),
    ).toBe(true);
    expect(
      observations.some(
        ({ properties }) =>
          properties.path === "data.json" &&
          properties.json_parse_status === "included",
      ),
    ).toBe(true);
    expect(
      result.graph.nodes.some(
        ({ kind, observations }) =>
          kind === "source-module" &&
          observations.some(
            ({ properties }) => properties.source === "original.js",
          ),
      ),
    ).toBe(true);
  });

  it(`${format} retains invalid UTF-8 as unavailable rather than replacing bytes`, async () => {
    const invalid = Buffer.from([0xef, 0xbb, 0xbf, 0xff]);
    const input = await createBomArtifact(format, {
      "invalid.js": invalid,
      "invalid.html": invalid,
    });
    const result = await reconstructJavaScriptArtifact({ input_path: input });
    expect(result.statistics.invalid_utf8_files).toBe(2);
    const observations = result.graph.nodes.flatMap(
      ({ observations }) => observations,
    );
    for (const path of ["invalid.js", "invalid.html"])
      expect(
        observations.some(
          ({ properties }) =>
            properties.path === path &&
            properties.text_status === "invalid-utf8",
        ),
      ).toBe(true);
  });
}
