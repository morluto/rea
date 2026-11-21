import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  importReferenceSource,
  requireReferenceSourceReads,
} from "../../support/referenceSourceResourceScope.js";

beforeEach(requireReferenceSourceReads);

it("retains external-module targets from exported and plain import-equals declarations", async () => {
  const root = await createTestTempDirectory(
    "rea-reference-exported-import-equals-",
  );
  await Promise.all([
    writeFile(
      join(root, "exported.cts"),
      'export import dep = require("./dep.cjs");\n',
    ),
    writeFile(
      join(root, "plain.cts"),
      'import dep = require("./dep.cjs"); export { dep };\n',
    ),
    writeFile(join(root, "dep.cjs"), "module.exports = { value: 1 };\n"),
  ]);

  const result = await importReferenceSource({
    root,
    caller: "reference-exported-import-equals-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  expect(result.value.relationships).toEqual(
    expect.arrayContaining([
      {
        from_path: "exported.cts",
        to: "dep.cjs",
        kind: "requires",
        resolution: "internal",
        parse_state: "parsed",
      },
      {
        from_path: "plain.cts",
        to: "dep.cjs",
        kind: "requires",
        resolution: "internal",
        parse_state: "parsed",
      },
    ]),
  );
  expect(result.value.relationships).toHaveLength(2);
});
