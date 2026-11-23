import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../../scripts/lint/rules/no-raw-cdp-session.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { writeRepositoryOxlintConfiguration } from "../fixtures/oxlintConfiguration.js";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "no-raw-cdp-session",
  rule,
  {
    valid: [
      "newPlaywrightCdpSession(context, page, operation)",
      'const name = "newCDPSession";',
    ],
    invalid: [
      {
        code: "context.newCDPSession(page)",
        errors: [{ messageId: "raw" }],
      },
      {
        code: 'context["newCDPSession"](page)',
        errors: [{ messageId: "raw" }],
      },
      {
        code: "browser.newBrowserCDPSession()",
        errors: [{ messageId: "raw" }],
      },
      {
        code: "const open = context.newCDPSession;",
        errors: [{ messageId: "raw" }],
      },
    ],
  },
);

it("allows raw Playwright CDP sessions only in their owner and tests, including browser verifier scripts", async () => {
  const root = await createTestTempDirectory("rea-cdp-session-lint-");
  const config = await writeRepositoryOxlintConfiguration(root);
  await mkdir(join(root, "src/browser"), { recursive: true });
  await mkdir(join(root, "scripts/lib"), { recursive: true });
  const source =
    "export const open = (context: any, page: any) => context.newCDPSession(page);\n";
  const script =
    "export const open = (context, page) => context.newCDPSession(page);\n";
  const files = [
    "src/browser/PlaywrightScenarioBrowser.ts",
    "src/browser/PlaywrightCdpSession.ts",
    "src/browser/PlaywrightScenarioBrowser.test.ts",
    "scripts/lib/browser-screenshot-e2e.mjs",
    "scripts/verify-browser-dom-destinations.mjs",
  ];
  for (const file of files)
    await writeFile(join(root, file), file.endsWith(".mjs") ? script : source);
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/oxlint/bin/oxlint"),
      "--threads=1",
      "-c",
      config,
      "--format",
      "json",
      ...files,
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
      .filter(({ code }) => code.includes("no-raw-cdp-session"))
      .map(({ filename }) => filename.replaceAll("\\", "/")),
  ).toEqual(
    expect.arrayContaining([
      "src/browser/PlaywrightScenarioBrowser.ts",
      "scripts/lib/browser-screenshot-e2e.mjs",
      "scripts/verify-browser-dom-destinations.mjs",
    ]),
  );
  expect(
    report.diagnostics.filter(({ code }) =>
      code.includes("no-raw-cdp-session"),
    ),
  ).toHaveLength(3);
});
