import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { importReferenceSource } from "../../../src/application/ReferenceSourceImport.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("distinguishes computed require member values from literal members in source evidence", async () => {
  const root = await createTestTempDirectory("rea-reference-require-members-");
  const sources = {
    "computed.cjs": [
      'const resolve = "toString";',
      'const main = "toString";',
      'const value = require[resolve]("./dep.js");',
      'require[main]("./dep.js");',
      "console.log(typeof value);",
    ].join("\n"),
    "literal.cjs": 'console.log(require["resolve"]("./dep.js"));\n',
    "dep.js": 'throw new Error("The dependency must not execute");\n',
    "unknown.cjs": [
      "function load(target) {",
      "  require(target);",
      "  require.resolve(target);",
      '  require["resolve"](target);',
      "  return import(target);",
      "}",
    ].join("\n"),
  };
  await Promise.all(
    Object.entries(sources).map(([path, source]) =>
      writeFile(join(root, path), source),
    ),
  );

  // These owned producers demonstrate the member's runtime meaning without
  // loading the throwing dependency. The importer itself never executes them.
  const runNode = promisify(execFile);
  for (const [path, stdout] of [
    ["computed.cjs", "string\n"],
    ["literal.cjs", `${join(root, "dep.js")}\n`],
  ] as const) {
    const executed = await runNode(process.execPath, [join(root, path)], {
      cwd: root,
      timeout: 5_000,
    });
    expect(executed.stdout).toBe(stdout);
    expect(executed.stderr).toBe("");
  }

  const result = await importReferenceSource({
    root,
    caller: "reference-require-members-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  const graph = result.value;
  expect(graph.parse_failures).toEqual([]);
  expect(graph.relationships).toEqual([
    {
      from_path: "literal.cjs",
      to: "dep.js",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    },
    {
      from_path: "unknown.cjs",
      to: "<dynamic-import>",
      kind: "imports",
      resolution: "unknown",
      parse_state: "partial",
    },
  ]);
  expect(graph.entries).toHaveLength(Object.keys(sources).length);
  for (const [path, source] of Object.entries(sources)) {
    expect(graph.entries).toContainEqual({
      path,
      kind: "file",
      sha256: createHash("sha256").update(source).digest("hex"),
      size: Buffer.byteLength(source),
      language: "JavaScript",
      classifications: ["source"],
      content_state: "hashed",
      limitations: [],
    });
  }
});
