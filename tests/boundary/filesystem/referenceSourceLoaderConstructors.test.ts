import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

it("retains constructor loader requests without inventing host authority", async () => {
  const root = await createTestTempDirectory("rea-reference-loader-new-");
  await Promise.all([
    writeFile(join(root, "direct.cjs"), 'new require("./dep.cjs");'),
    writeFile(join(root, "wrapped.cts"), 'new (require as any)("./dep.cjs");'),
    writeFile(join(root, "wrapped-call.cts"), '(require as any)("./dep.cjs");'),
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
  expect(result.value.relationships).toContainEqual({
    from_path: "direct.cjs",
    to: "dep.cjs",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(result.value.relationships).toContainEqual({
    from_path: "wrapped.cts",
    to: "dep.cjs",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(result.value.relationships).toContainEqual({
    from_path: "wrapped-call.cts",
    to: "dep.cjs",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(result.value.relationships).toContainEqual({
    from_path: "wrapped-resolve.cts",
    to: "dep.cjs",
    kind: "requires",
    resolution: "internal",
    parse_state: "parsed",
  });
  expect(result.value.relationships).toContainEqual({
    from_path: "alias.MJS",
    to: "./dep.cjs",
    kind: "requires",
    resolution: "unknown",
    parse_state: "partial",
  });
  expect(
    result.value.relationships.some(({ from_path }) =>
      ["shadow.MJS", "wrapped-mutated.cts"].includes(from_path),
    ),
  ).toBe(false);
});
