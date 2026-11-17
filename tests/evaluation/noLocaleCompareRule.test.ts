import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../../scripts/lint/rules/no-locale-compare.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { writeRepositoryOxlintConfiguration } from "../fixtures/oxlintConfiguration.js";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "no-locale-compare",
  rule,
  {
    valid: [
      'const example = "a.localeCompare(b)";',
      "// a.localeCompare(b)\nconst x = a < b;",
      "compareUnicodeCodePoints(a, b)",
    ],
    invalid: [
      { code: "a.localeCompare(b)", errors: [{ messageId: "locale" }] },
      { code: "a.localeCompare (b)", errors: [{ messageId: "locale" }] },
      { code: 'a["localeCompare"](b)', errors: [{ messageId: "locale" }] },
      { code: "a[`localeCompare`](b)", errors: [{ messageId: "locale" }] },
      { code: "a?.localeCompare(b)", errors: [{ messageId: "locale" }] },
    ],
  },
);

it("applies the ordering rule to domain production files and excludes tests", async () => {
  const root = await createTestTempDirectory("rea-ordering-lint-");
  const config = await writeRepositoryOxlintConfiguration(root);
  await mkdir(join(root, "src/domain"), { recursive: true });
  const source =
    "export const compare = (a: string, b: string) => a.localeCompare(b);\n";
  await writeFile(join(root, "src/domain/ordering.ts"), source);
  await writeFile(join(root, "src/domain/ordering.test.ts"), source);
  await writeFile(join(root, "src/domain/ordering.spec.ts"), source);
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/oxlint/bin/oxlint"),
      "-c",
      config,
      "--format",
      "json",
      "src/domain/ordering.ts",
      "src/domain/ordering.test.ts",
      "src/domain/ordering.spec.ts",
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
      .filter(({ code }) => code.includes("no-locale-compare"))
      .map(({ filename }) => filename.replaceAll("\\", "/")),
  ).toEqual(["src/domain/ordering.ts"]);
});
