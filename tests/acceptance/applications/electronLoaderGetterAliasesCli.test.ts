import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import {
  LOADER_GETTER_REPLACEMENT as replacement,
  webpackGetterSource,
} from "../../../src/domain/javascript/electronBundledGetter.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "selects loader getter identity through destructuring defaults through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-loader-getter-aliases-");
    const cases = [
      ["intact.cjs", ""],
      [
        "unused-object-default.cjs",
        `const { api: alias = load } = { api: {} }; alias.n = ${replacement};`,
      ],
      [
        "unused-array-default.cjs",
        `const [alias = load] = [{}]; alias.n = ${replacement};`,
      ],
      [
        "undefined-own-slot.cjs",
        `const { api: alias = load } = { api: undefined }; alias.n = ${replacement};`,
      ],
      [
        "used-object-default.cjs",
        `const { api: alias = load } = {}; alias.n = ${replacement};`,
      ],
      [
        "used-array-default.cjs",
        `const [alias = load] = []; alias.n = ${replacement};`,
      ],
      [
        "changed-object-default.cjs",
        `const source = { api: {} }; source.api = undefined; const { api: alias = load } = source; alias.n = ${replacement};`,
      ],
      [
        "changed-array-default.cjs",
        `const source = [{}]; source[0] = undefined; const [alias = load] = source; alias.n = ${replacement};`,
      ],
      [
        "inherited-nested-default.cjs",
        `Object.prototype.api = { inner: undefined }; const { api: { inner: alias = load } = { inner: {} } } = {}; alias.n = ${replacement};`,
      ],
      [
        "intrinsic-nested-default.cjs",
        `const { constructor: { missing: alias = load } = { missing: {} } } = {}; alias.n = ${replacement};`,
      ],
      [
        "inherited-array-default.cjs",
        `Array.prototype[0] = { inner: undefined }; const [{ inner: alias = load } = { inner: {} }] = []; alias.n = ${replacement};`,
      ],
      [
        "own-nested-default.cjs",
        `Object.prototype.api = { inner: undefined }; const { api: { inner: alias = load } = { inner: {} } } = { api: { inner: {} } }; alias.n = ${replacement};`,
      ],
      [
        "dead-nested-default.cjs",
        `const { api: { inner: alias = load } = { inner: {} } } = {}; alias.n = ${replacement};`,
      ],
    ] as const;
    for (const [name, mutation] of cases)
      await writeFile(
        join(root, name),
        `${webpackGetterSource(mutation)}\nthrow new Error("source must remain inert");`,
      );

    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics).toMatchObject({
      parsed_javascript_files: cases.length,
      parse_failures: 0,
    });
    expect(result.summary.browser_windows).toBe(5);
    const windows = result.graph.nodes.filter(
      ({ kind }) => kind === "browser-window",
    );
    expect(windows).toHaveLength(5);
    expect(
      windows
        .flatMap(({ observations }) =>
          observations.map(({ properties }) => properties.source_path),
        )
        .sort(),
    ).toEqual([
      "dead-nested-default.cjs",
      "intact.cjs",
      "own-nested-default.cjs",
      "unused-array-default.cjs",
      "unused-object-default.cjs",
    ]);
    for (const [name] of cases)
      expect(
        result.graph.nodes.flatMap(({ observations }) => observations),
      ).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            reference_kind: "require",
            specifier: "electron",
          }),
          evidence: expect.objectContaining({
            location: {
              available: true,
              value: expect.objectContaining({ source: name }),
            },
          }),
        }),
      );
  },
);
