import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  reconstructJavaScriptFixture,
  writeFixtureFiles,
} from "../../../support/javascriptApplicationFixture.js";

// The table is selected, but this helper ignores it and loads only the direct import.
const viteBuild = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-vite-output-");
  await writeFixtureFiles(root, {
    "index.html":
      '<!doctype html><script type="module" src="/assets/index.js"></script>',
    "assets/index.js": `
      const __vite__mapDeps = (i, m = __vite__mapDeps, d =
        (m.f || (m.f = ["assets/lazy.js", "assets/missing.js"]))) => i.map((i) => d[i]);
      const preload = (load, deps) => load();
      export const route = () =>
        preload(() => import("./lazy.js"), __vite__mapDeps([0, 1]));
    `,
    "assets/lazy.js": "export const lazy = true;",
  });
  return root;
};

const tableCandidates = (
  graph: Awaited<ReturnType<typeof reconstructJavaScriptFixture>>["graph"],
) =>
  graph.nodes
    .filter(({ kind }) => kind === "unknown")
    .flatMap(({ observations }) => observations)
    .filter(({ properties }) => properties.vite_table_candidate === true)
    .map(({ properties }) => properties);

describe("Vite dependency table candidates", () => {
  it("retains table values without asserting they are imports", async () => {
    const result = await reconstructJavaScriptFixture(await viteBuild());
    expect(tableCandidates(result.graph)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "assets/lazy.js",
          resolution_status: "unavailable",
          candidate_path: "assets/lazy.js",
        }),
        expect.objectContaining({
          specifier: "assets/missing.js",
          resolution_status: "unavailable",
        }),
      ]),
    );
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            specifier: "./lazy.js",
            resolution_status: "resolved",
            resolved_path: "assets/lazy.js",
          }),
        }),
      ]),
    );
    expect(
      result.graph.edges.some(
        ({ relation, properties }) =>
          relation === "imports" && properties.specifier === "assets/lazy.js",
      ),
    ).toBe(false);
    expect(result.graph.coverage.status).toBe("partial");
  });

  it("does not classify a table value as an external package when selecting the assets directory", async () => {
    const root = await viteBuild();
    const result = await reconstructJavaScriptFixture(join(root, "assets"));
    expect(JSON.stringify(result.graph)).not.toContain(
      '"resolution_status":"external"',
    );
    expect(tableCandidates(result.graph)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "assets/lazy.js",
          resolution_status: "unavailable",
        }),
      ]),
    );
  });

  it("retains an inventoried CSS file as a candidate under a nested build output directory", async () => {
    const root = await createTestTempDirectory("rea-vite-output-css-");
    await writeFixtureFiles(root, {
      "dist/index.html":
        '<!doctype html><script type="module" src="/assets/index.js"></script>',
      "dist/assets/index.js": `
        const __vite__mapDeps = (i, m = __vite__mapDeps, d =
          (m.f || (m.f = ["assets/lazy.css"]))) => i.map((i) => d[i]);
        export const route = () => __vite__mapDeps([0]);
      `,
      "dist/assets/lazy.css": ".lazy { color: green; }",
    });
    const result = await reconstructJavaScriptFixture(root);
    expect(tableCandidates(result.graph)).toContainEqual(
      expect.objectContaining({
        specifier: "assets/lazy.css",
        resolution_status: "unavailable",
        candidate_path: "dist/assets/lazy.css",
      }),
    );
  });
});
