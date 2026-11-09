import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

const loaderSources = {
  ".MJS": 'import {join} from "node:path"; require("./dep.cjs");',
  ".TS": 'import {join} from "node:path"; require("./dep.cjs");',
  "child-call.cjs": 'require.call.extra=1; require.call(null,"./dep.cjs");',
  "child-apply.cjs":
    'require.apply.extra=1; require.apply(null,["./dep.cjs"]);',
  "child-resolve.cjs": 'require.resolve.extra=1; require.resolve("./dep.cjs");',
  "direct.cjs": 'new require("./dep.cjs");',
  "wrapped.cts": 'new (require as any)("./dep.cjs");',
  "wrapped-call.cts": '(require as any)("./dep.cjs");',
  "alias-direct.cjs": 'const box={load:require};box.load("./dep.cjs");',
  "alias-direct-replaced.cjs":
    'const box={load:require};box.load=()=>0;box.load("./dep.cjs");',
  "alias-direct-deferred.cjs":
    'const box={load:require};function replace(){box.load=()=>0} replace();box.load("./dep.cjs");',
  "nested-call.cjs":
    'const box={load:require};box.load.call(null,"./dep.cjs");',
  "nested-mutated.cjs":
    'const box={load:require};box.load.call=()=>0;box.load.call(null,"./dep.cjs");',
  "nested-parent.cjs":
    'const box={load:require};box.load=()=>0;box.load.call(null,"./dep.cjs");',
  "nested-child.cjs":
    'const box={load:require};box.load.call.extra=1;box.load.call(null,"./dep.cjs");',
  "nested-apply.cjs":
    'const box={load:require};box.load.apply(null,["./dep.cjs"]);',
  "nested-unknown.MJS":
    'const box={load:require};box.load.call(null,"./dep.cjs");',
  "wrapped-receiver.TS": '(require as any).resolve("./dep.cjs");',
  "wrapped-resolve.cts": '(require as any).resolve("./dep.cjs");',
  "wrapped-mutated.cts":
    'require.call=()=>0; (require.call as any)(null,"./dep.cjs");',
  "alias.MJS": 'const load=require; new load("./dep.cjs");',
  "shadow.MJS": 'const require=function() {}; new require("./dep.cjs");',
  "dep.cjs": "module.exports = {};",
};

it("retains constructor loader requests without inventing host authority", async () => {
  const root = await createTestTempDirectory("rea-reference-loader-new-");
  await Promise.all(
    Object.entries(loaderSources).map(([path, source]) =>
      writeFile(join(root, path), source),
    ),
  );
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
    "child-call.cjs",
    "child-apply.cjs",
    "child-resolve.cjs",
    "wrapped.cts",
    "wrapped-call.cts",
    "nested-call.cjs",
    "alias-direct.cjs",
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
  for (const from_path of [
    "nested-unknown.MJS",
    "alias.MJS",
    ".MJS",
    ".TS",
    "wrapped-receiver.TS",
    "alias-direct-replaced.cjs",
    "alias-direct-deferred.cjs",
  ]) {
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
