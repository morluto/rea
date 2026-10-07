import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

import { expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const cases: readonly {
  name: string;
  metadata: Readonly<Record<string, unknown>>;
  index: boolean;
  specifier?: string;
  extraFiles?: Readonly<Record<string, string>>;
}[] = [
  { name: "main before index", metadata: { main: "actual.cjs" }, index: true },
  {
    name: "exports before index",
    metadata: { exports: { require: "./actual.cjs" } },
    index: true,
  },
  {
    name: "main without an index",
    metadata: { main: "actual.cjs" },
    index: false,
  },
  { name: "index fallback", metadata: {}, index: true },
  {
    name: "missing legacy main fallback",
    metadata: { main: "missing.cjs" },
    index: true,
  },
  { name: "self-directory main", metadata: { main: "." }, index: true },
  {
    name: "bare exports with legacy main",
    metadata: { main: "legacy.cjs", exports: "./actual.cjs" },
    index: true,
    extraFiles: {
      "node_modules/fixture/legacy.cjs": "module.exports = 'legacy';",
    },
  },
  {
    name: "relative directory ignores exports",
    metadata: { main: "legacy.cjs", exports: "./actual.cjs" },
    index: true,
    specifier: "./node_modules/fixture",
    extraFiles: {
      "node_modules/fixture/legacy.cjs": "module.exports = 'legacy';",
    },
  },
  {
    name: "relative exports-only directory uses index",
    metadata: { exports: "./actual.cjs" },
    index: true,
    specifier: "./node_modules/fixture",
  },
  {
    name: "legacy main directory uses its index",
    metadata: { main: "./lib" },
    index: true,
    extraFiles: {
      "node_modules/fixture/lib/package.json": '{"main":"actual.cjs"}',
      "node_modules/fixture/lib/actual.cjs": "module.exports = 'nested';",
      "node_modules/fixture/lib/index.js": "module.exports = 'nested index';",
    },
  },
  {
    name: "legacy main directory falls back to root index",
    metadata: { main: "./lib" },
    index: true,
    extraFiles: {
      "node_modules/fixture/lib/package.json": '{"main":"actual.cjs"}',
      "node_modules/fixture/lib/actual.cjs": "module.exports = 'nested';",
    },
  },
  {
    name: "legacy main cycle falls back to root index",
    metadata: { main: "./lib" },
    index: true,
    extraFiles: { "node_modules/fixture/lib/package.json": '{"main":".."}' },
  },
  {
    name: "null exports preserves legacy main",
    metadata: { exports: null, main: "actual.cjs" },
    index: true,
  },
];

it.each(cases)(
  "matches Node package resolution for $name",
  async ({ metadata, index, specifier = "fixture", extraFiles = {} }) => {
    const root = await createTestTempDirectory("rea-package-precedence-");
    const files = {
      ...extraFiles,
      "package.json": JSON.stringify({
        name: "app",
        type: "commonjs",
        main: "main.cjs",
      }),
      "main.cjs": `const value = require(${JSON.stringify(specifier)}); module.exports = value;`,
      "node_modules/fixture/package.json": JSON.stringify({
        name: "fixture",
        ...metadata,
      }),
      "node_modules/fixture/actual.cjs": "module.exports = 'actual entry';",
      ...(index
        ? {
            "node_modules/fixture/index.js":
              "module.exports = 'fallback entry';",
          }
        : {}),
    };
    await Promise.all(
      Object.entries(files).map(async ([path, text]) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }),
    );
    const expected = relative(
      root,
      createRequire(join(root, "main.cjs")).resolve(specifier),
    )
      .split(sep)
      .join("/");
    const result = await reconstructJavaScriptArtifact({
      input_path: root,
      format: "directory",
    });
    const edge = result.graph.edges.find(
      ({ properties }) =>
        properties.module_link_kind === "require" &&
        properties.specifier === specifier,
    );

    expect(edge?.properties).toMatchObject({
      resolution_status: "resolved",
      resolved_path: expected,
    });
    expect(result.graph.coverage.status).toBe("complete");
  },
);
