import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { findTypedScriptSiblingDeclarations } from "../../../scripts/verify/typed-script-declarations-guard.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["scripts/lib/example.mjs", "scripts/lib/example.d.mts"],
  ["scripts/lib/example.mjs", "scripts/lib/example.d.ts"],
  ["scripts/lib/example.js", "scripts/lib/example.d.ts"],
])("rejects %s when sibling %s exists", async (scriptPath, declarationPath) => {
  const root = await createTestTempDirectory("rea-typed-script-guard-");
  await mkdir(join(root, "scripts", "lib"), { recursive: true });
  await writeFile(
    join(root, "tsconfig.scripts.json"),
    JSON.stringify({ files: [scriptPath] }),
  );
  await writeFile(join(root, scriptPath), "export const value = 1;\n");
  await writeFile(
    join(root, declarationPath),
    "export declare const value: number;\n",
  );

  await expect(findTypedScriptSiblingDeclarations(root)).resolves.toEqual([
    declarationPath,
  ]);
});

it("accepts a typed script with no sibling declaration file", async () => {
  const root = await createTestTempDirectory("rea-typed-script-guard-");
  await mkdir(join(root, "scripts", "lib"), { recursive: true });
  await writeFile(
    join(root, "tsconfig.scripts.json"),
    JSON.stringify({ files: ["scripts/lib/example.mjs"] }),
  );
  await writeFile(
    join(root, "scripts/lib/example.mjs"),
    "export const value = 1;\n",
  );

  await expect(findTypedScriptSiblingDeclarations(root)).resolves.toEqual([]);
});
