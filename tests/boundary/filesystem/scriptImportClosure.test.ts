import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  copyScriptsWithImports,
  scriptImportClosure,
} from "../../support/scriptImportClosure.js";

const repository = async (
  files: Record<string, string>,
  imports: Record<string, string> = {},
) => {
  const root = await createTestTempDirectory("rea-import-closure-");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module", imports }),
  );
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return root;
};

it("follows runtime imports and verifier source loads, not type-only edges or packages", async () => {
  const root = await repository({
    "scripts/entry.mjs": [
      'import { parse } from "yaml";',
      'import { helper } from "./lib/helper.mjs";',
      'const later = await import("./lib/later.mjs");',
      "const { value } = await importVerifierSource(",
      '  "../src/value.ts",',
      "  import.meta.url,",
      ");",
      "const { later: again } = await importVerifierSource(",
      '  new URL("./lib/url.mts", import.meta.url).href,',
      "  import.meta.url,",
      ");",
      "const elsewhere = await importVerifierSource(selected, import.meta.url);",
      '// import "./lib/commented.mjs";',
    ].join("\n"),
    "scripts/lib/helper.mjs": 'export { shared } from "./shared.mjs";\n',
    "scripts/lib/shared.mjs": "export const shared = 1;\n",
    "scripts/lib/later.mjs": 'import "./shared.mjs";\n',
    "scripts/lib/url.mts": "export const later = 2;\n",
    "src/value.ts": [
      'import type { Shape } from "./shape.js";',
      'import { result } from "./result.js";',
      "export const value: Shape = result;",
    ].join("\n"),
    "src/result.ts": "export const result = 1;\n",
    "src/shape.ts": "export type Shape = number;\n",
  });
  expect(await scriptImportClosure(["scripts/entry.mjs"], root)).toEqual([
    "scripts/entry.mjs",
    "scripts/lib/helper.mjs",
    "scripts/lib/later.mjs",
    "src/value.ts",
    "scripts/lib/url.mts",
    "scripts/lib/shared.mjs",
    "src/result.ts",
  ]);
  const destination = await createTestTempDirectory("rea-import-copy-");
  await copyScriptsWithImports(["scripts/entry.mjs"], destination, root);
  expect(await readFile(join(destination, "src/result.ts"), "utf8")).toBe(
    "export const result = 1;\n",
  );
});

it("follows package imports to the file Node loads and leaves build output to the copy", async () => {
  const root = await repository(
    {
      "scripts/entry.mjs": [
        'import "#helper";',
        'const worker = await import("#worker");',
      ].join("\n"),
      "scripts/lib/helper.mjs": "export const helper = 1;\n",
      "src/worker.ts": "export const worker = 1;\n",
    },
    { "#helper": "./scripts/lib/helper.mjs", "#worker": "./dist/worker.js" },
  );
  expect(await scriptImportClosure(["scripts/entry.mjs"], root)).toEqual([
    "scripts/entry.mjs",
    "scripts/lib/helper.mjs",
  ]);
});

it("refuses a missing import or one outside the repository", async () => {
  const missing = await repository({
    "scripts/entry.mjs": 'import "./absent.mjs";\n',
  });
  await expect(
    scriptImportClosure(["scripts/entry.mjs"], missing),
  ).rejects.toThrow("scripts/entry.mjs imports scripts/absent.mjs");
  const escaping = await repository({
    "scripts/entry.mjs": 'import "../../outside.mjs";\n',
  });
  await expect(
    scriptImportClosure(["scripts/entry.mjs"], escaping),
  ).rejects.toThrow("is outside");
});
