import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../../scripts/lint/rules/typed-resource-refusal.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const construct = (options: string) =>
  `new AnalysisResourceConstraintError("op", "memory", "reason", null${options});`;

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "typed-resource-refusal",
  rule,
  {
    valid: [
      {
        code: construct(""),
        filename: resolve("src/application/JsonAuthenticationHeadroom.ts"),
      },
      construct(', fixedAllowanceOptions("The allowance", "count")'),
      construct(
        ', { cause, ...fixedAllowanceOptions("The allowance", "count") }',
      ),
      construct(", { limit: analysisSettingLimit(setting, value, source) }"),
      construct(', { remediationAction: "Raise the setting." }'),
      construct(", { retryable: true, measuredExhaustion: true }"),
      construct(", recovery"),
      'new AnalysisInputError("op", { cause });',
    ],
    invalid: [
      {
        code: construct("") + construct(""),
        filename: resolve("src/application/JsonAuthenticationHeadroom.ts"),
        errors: [{ messageId: "untyped" }, { messageId: "untyped" }],
      },
      {
        code: "const value = 1;",
        filename: resolve("src/application/JsonAuthenticationHeadroom.ts"),
        errors: [{ messageId: "stale", data: { allowed: "1", actual: "0" } }],
      },
      { code: construct(""), errors: [{ messageId: "untyped" }] },
      { code: construct(", { cause }"), errors: [{ messageId: "untyped" }] },
      {
        code: construct(", { retryable: false, diagnostics: {} }"),
        errors: [{ messageId: "untyped" }],
      },
    ],
  },
);

it("keeps the untyped-refusal baseline to files that still need migration", async () => {
  const baseline = JSON.parse(
    await readFile(
      "scripts/lint/rules/typed-resource-refusal-baseline.json",
      "utf8",
    ),
  ) as Record<string, number>;
  for (const [file, count] of Object.entries(baseline)) {
    expect(file).toMatch(/^src\/.+\.ts$/u);
    expect(count).toBeGreaterThan(0);
    // A file whose untyped constructions are gone must leave the baseline.
    expect(await readFile(file, "utf8")).toContain(
      "new AnalysisResourceConstraintError(",
    );
  }
});
