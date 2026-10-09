import { describe, expect, it } from "vitest";

import { parseReferenceSourceImports } from "./referenceSourceImportParsing.js";

const parse = (source: string) =>
  parseReferenceSourceImports(
    "main.ts",
    new TextEncoder().encode(source),
    "TypeScript",
  );

describe("historical source dynamic imports", () => {
  it.each([
    'import("./lazy.js");',
    'const module = import("./lazy.js");',
    'async function load() { return await import("./lazy.js"); }',
    'import("./lazy.js", { with: { type: "json" } });',
  ])("retains the literal dependency in %s", (source) => {
    expect(parse(source)).toEqual({
      relationships: [
        {
          from_path: "main.ts",
          to: "./lazy.js",
          kind: "imports",
          resolution: "internal",
          parse_state: "parsed",
        },
      ],
      parse_failures: [],
    });
  });

  it.each([
    "import(moduleName);",
    "async function load(name: string) { return await import(name); }",
    "import(`./${moduleName}.js`);",
  ])("keeps a computed dependency unknown in %s", (source) => {
    expect(parse(source)).toEqual({
      relationships: [
        {
          from_path: "main.ts",
          to: "<dynamic-import>",
          kind: "imports",
          resolution: "unknown",
          parse_state: "partial",
        },
      ],
      parse_failures: [],
    });
  });

  it("retains static import and require relationships alongside dynamic imports", () => {
    const result = parse(
      'import "./static.js"; require("./common.cjs"); import("node:fs");',
    );
    expect(result.parse_failures).toEqual([]);
    expect(result.relationships).toEqual([
      {
        from_path: "main.ts",
        to: "./static.js",
        kind: "imports",
        resolution: "internal",
        parse_state: "parsed",
      },
      {
        from_path: "main.ts",
        to: "./common.cjs",
        kind: "requires",
        resolution: "internal",
        parse_state: "parsed",
      },
      {
        from_path: "main.ts",
        to: "node:fs",
        kind: "imports",
        resolution: "external",
        parse_state: "parsed",
      },
    ]);
  });
});

it("retains dependencies beside a deeply nested generated member chain", () => {
  const expression = `object${".property".repeat(20_000)}`;
  const result = parse(
    `const value = ${expression}; require("./first.cjs"); import("./last.js");`,
  );
  expect(result.parse_failures).toEqual([]);
  expect(result.relationships.map(({ to, kind }) => ({ to, kind }))).toEqual([
    { to: "./first.cjs", kind: "requires" },
    { to: "./last.js", kind: "imports" },
  ]);
});
