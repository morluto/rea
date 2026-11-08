import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

it("retains constructor loader requests without inventing host authority", async () => {
  const root = await createTestTempDirectory("rea-reference-loader-new-");
  await Promise.all([
    writeFile(
      join(root, ".MJS"),
      'import {join} from "node:path"; require("./dep.cjs");',
    ),
    writeFile(
      join(root, ".TS"),
      'import {join} from "node:path"; require("./dep.cjs");',
    ),
    writeFile(join(root, "direct.cjs"), 'new require("./dep.cjs");'),
    writeFile(join(root, "wrapped.cts"), 'new (require as any)("./dep.cjs");'),
    writeFile(join(root, "wrapped-call.cts"), '(require as any)("./dep.cjs");'),
    writeFile(
      join(root, "nested-call.cjs"),
      'const box={load:require};box.load.call(null,"./dep.cjs");',
    ),
    writeFile(
      join(root, "nested-mutated.cjs"),
      'const box={load:require};box.load.call=()=>0;box.load.call(null,"./dep.cjs");',
    ),
    writeFile(
      join(root, "nested-parent.cjs"),
      'const box={load:require};box.load=()=>0;box.load.call(null,"./dep.cjs");',
    ),
    writeFile(
      join(root, "nested-child.cjs"),
      'const box={load:require};box.load.call.extra=1;box.load.call(null,"./dep.cjs");',
    ),
    writeFile(
      join(root, "nested-apply.cjs"),
      'const box={load:require};box.load.apply(null,["./dep.cjs"]);',
    ),
    writeFile(
      join(root, "nested-unknown.MJS"),
      'const box={load:require};box.load.call(null,"./dep.cjs");',
    ),
    writeFile(
      join(root, "wrapped-resolve.cts"),
      '(require as any).resolve("./dep.cjs");',
    ),
    writeFile(
      join(root, "wrapped-mutated.cts"),
      'require.call=()=>0; (require.call as any)(null,"./dep.cjs");',
    ),
    writeFile(
      join(root, "alias.MJS"),
      'const load=require; new load("./dep.cjs");',
    ),
    writeFile(
      join(root, "shadow.MJS"),
      'const require=function() {}; new require("./dep.cjs");',
    ),
    writeFile(join(root, "dep.cjs"), "module.exports = {};"),
  ]);
  const result = await importReferenceSource({
    root,
    caller: "reference-loader-constructor-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: ".MJS",
        language: "JavaScript",
        classifications: ["source"],
      }),
      expect.objectContaining({
        path: ".TS",
        language: "TypeScript",
        classifications: ["source"],
      }),
    ]),
  );
  for (const from_path of [
    "direct.cjs",
    "wrapped.cts",
    "wrapped-call.cts",
    "nested-call.cjs",
    "nested-child.cjs",
    "nested-apply.cjs",
    "wrapped-resolve.cts",
  ]) {
    expect(result.value.relationships).toContainEqual({
      from_path,
      to: "dep.cjs",
      kind: "requires",
      resolution: "internal",
      parse_state: "parsed",
    });
  }
  for (const from_path of ["nested-unknown.MJS", "alias.MJS", ".MJS", ".TS"]) {
    expect(result.value.relationships).toContainEqual({
      from_path,
      to: "./dep.cjs",
      kind: "requires",
      resolution: "unknown",
      parse_state: "partial",
    });
  }
  expect(
    result.value.relationships.some(({ from_path }) =>
      [
        "shadow.MJS",
        "wrapped-mutated.cts",
        "nested-mutated.cjs",
        "nested-parent.cjs",
      ].includes(from_path),
    ),
  ).toBe(false);
});
