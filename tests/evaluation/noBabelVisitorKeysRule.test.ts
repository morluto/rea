import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../../scripts/lint/rules/no-babel-visitor-keys.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { writeRepositoryOxlintConfiguration } from "../fixtures/oxlintConfiguration.js";

RuleTester.describe = describe;
RuleTester.it = it;
new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "no-babel-visitor-keys",
  rule,
  {
    valid: [
      'const text = "VISITOR_KEYS";',
      "const config = { VISITOR_KEYS: 1 }; config.VISITOR_KEYS;",
      'import * as types from "@babel/types"; types.isIdentifier(node);',
      'import { VISITOR_KEYS } from "unrelated";',
      'import * as types from "@babel/types"; function f(types: { VISITOR_KEYS: number }) { return types.VISITOR_KEYS; }',
    ],
    invalid: [
      {
        code: 'import { VISITOR_KEYS as keys } from "@babel/types";',
        errors: [{ messageId: "owner" }],
      },
      {
        code: 'export { VISITOR_KEYS as keys } from "@babel/types";',
        errors: [{ messageId: "owner" }],
      },
      {
        code: 'import * as t from "@babel/types"; t.VISITOR_KEYS;',
        errors: [{ messageId: "owner" }],
      },
      {
        code: 'import * as t from "@babel/types"; t["VISITOR_KEYS"];',
        errors: [{ messageId: "owner" }],
      },
      {
        code: 'import * as t from "@babel/types"; const { VISITOR_KEYS: keys } = t;',
        errors: [{ messageId: "owner" }],
      },
    ],
  },
);

it("limits the shared Babel child expansion exception to its owner", async () => {
  const root = await createTestTempDirectory("rea-visitor-lint-");
  const config = await writeRepositoryOxlintConfiguration(root);
  await mkdir(join(root, "src/domain/javascript"), { recursive: true });
  const source =
    'import * as t from "@babel/types"; export const keys = t.VISITOR_KEYS;\n';
  await writeFile(
    join(root, "src/domain/javascript/javascriptSemanticTraversal.ts"),
    source,
  );
  await writeFile(join(root, "src/domain/javascript/other.ts"), source);
  await writeFile(join(root, "src/domain/javascript/other.spec.ts"), source);
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/oxlint/bin/oxlint"),
      "-c",
      config,
      "--format",
      "json",
      "src/domain/javascript/javascriptSemanticTraversal.ts",
      "src/domain/javascript/other.ts",
      "src/domain/javascript/other.spec.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(result.stdout) as {
    diagnostics: Array<{ filename: string; code: string }>;
  };
  expect(
    report.diagnostics
      .filter(({ code }) => code.includes("no-babel-visitor-keys"))
      .map(({ filename }) => filename.replaceAll("\\", "/")),
  ).toEqual(["src/domain/javascript/other.ts"]);
});
