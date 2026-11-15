import { expect, it } from "vitest";

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
  expect(refused.limitations).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /^CommonJS require calls in probe\.js were not examined because the member-mutation phase was refused \(JavaScript member-mutation analysis scheduled more than 1 alias states for one source\)\. The effective javascript\.member_mutation_alias_states value is 1 alias states \(source setting;/u,
      ),
    ]),
  );
});
