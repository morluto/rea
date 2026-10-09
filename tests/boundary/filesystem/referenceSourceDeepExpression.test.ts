import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("imports valid generated source without exhausting the owned Node process stack", async () => {
  const root = await createTestTempDirectory("rea-reference-deep-expression-");
  const expression = `object${".property".repeat(20_000)}`;
  await Promise.all([
    writeFile(
      join(root, "main.js"),
      `const value = ${expression}; import "./dep.js";`,
    ),
    writeFile(join(root, "dep.js"), "export {};"),
  ]);
  const importer = new URL(
    "../../../dist/application/ReferenceSourceImport.js",
    import.meta.url,
  ).href;
  const script = `
    import { importReferenceSource } from ${JSON.stringify(importer)};
    const result = await importReferenceSource({
      root: ${JSON.stringify(root)},
      caller: "deep-expression-regression",
      policy: { secretPatterns: [] },
    });
    if (!result.ok) throw result.error;
    if (result.value.parse_failures.length !== 0) throw new Error("Unexpected parse failures");
    console.log(JSON.stringify(result.value.relationships));
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 10_000, env: { HOME: root, TMPDIR: root } },
  );
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual([
    {
      from_path: "main.js",
      to: "dep.js",
      kind: "imports",
      resolution: "internal",
      parse_state: "parsed",
    },
  ]);
});
