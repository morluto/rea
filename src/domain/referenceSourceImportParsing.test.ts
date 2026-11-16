import { expect, it } from "vitest";

import { javaScriptMemberMutationRefusal } from "./javascript/javascriptSemanticWorkAllowance.js";
import { parseReferenceSourceImports } from "./referenceSourceImportParsing.js";

/** Conditional self-selections before one member write (#8294). */
const SOURCE = [
  "function probe(input, env) { var m; if (env.first) m = env.first.info;",
  ...Array.from(
    { length: 4 },
    (_, index) =>
      `if (/case${String(index)}/.test(input)) m = m[${String(index % 2)}];`,
  ),
  "m[1] = input.length; return m; }",
  "module.exports = probe;",
  'const other = require.call(null, "./other");',
  'import("./lazy");',
].join("\n");

it("keeps declaration-level imports when the member-mutation phase is refused", () => {
  const admitted = parseReferenceSourceImports(
    "probe.js",
    Buffer.from(SOURCE),
    "JavaScript",
    "commonjs",
  );
  expect(admitted.relationships.map(({ to, kind }) => [kind, to])).toEqual(
    expect.arrayContaining([
      ["requires", "./other"],
      ["imports", "./lazy"],
    ]),
  );
  const refused = parseReferenceSourceImports(
    "probe.js",
    Buffer.from(SOURCE),
    "JavaScript",
    "commonjs",
    { aliasStates: 1, source: "setting" },
  );
  expect(refused.relationships.map(({ to, kind }) => [kind, to])).toEqual([
    ["imports", "./lazy"],
  ]);
  expect(refused.parse_failures).toEqual([]);
  // The limitation carries the owning formatter's recovery for this file.
  const owner = javaScriptMemberMutationRefusal(
    "analyze_javascript_semantics",
    {
      aliasStates: 1,
      source: "setting",
    },
  );
  expect(
    refused.limitations.filter(
      (limitation) =>
        limitation.includes("probe.js") &&
        limitation.includes(owner.remediationAction ?? "<missing>"),
    ),
  ).toHaveLength(1);
});

it.each([
  ["main.mjs", "commonjs", true],
  ["main.js", "module", true],
  ["main.cjs", "module", false],
  ["main.js", "commonjs", false],
  ["main.mts", "commonjs", true],
  ["main.cts", "module", true],
  ["main.ts", "commonjs", true],
  ["main.tsx", "module", true],
  ["main.TSX", "module", true],
] as const)(
  "retains the loader's BOM/hashbang semantics for %s (%s)",
  (path, packageType, valid) => {
    const esm =
      path.endsWith(".mjs") ||
      path.endsWith(".mts") ||
      (!path.endsWith(".cjs") &&
        !path.endsWith(".cts") &&
        packageType === "module");
    const statement = esm ? 'import "./dep.mjs";' : 'require("./dep.cjs");';
    const parsed = parseReferenceSourceImports(
      path,
      Buffer.from(`\uFEFF#!/usr/bin/env node\n${statement}`),
      path.endsWith("js") ? "JavaScript" : "TypeScript",
      packageType,
    );
    if (valid) {
      expect(parsed.parse_failures).toEqual([]);
      expect(parsed.relationships).toMatchObject([
        { to: esm ? "./dep.mjs" : "./dep.cjs", parse_state: "parsed" },
      ]);
    } else {
      expect(parsed.parse_failures).toHaveLength(1);
      expect(parsed.relationships).toEqual([]);
    }
  },
);
