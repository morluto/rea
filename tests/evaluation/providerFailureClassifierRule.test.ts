import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../../scripts/lint/rules/provider-failure-classifier.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
const baselineFile = resolve("src/adb/AdbProvider.ts");

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "provider-failure-classifier",
  rule,
  {
    valid: [
      "const classify = (outcome: ProviderOutcome): AnalysisError => error;",
      "const message = (cause: unknown): string => String(cause);",
      "const recover = (cause: unknown): Result<number, AnalysisError> => ok(1);",
      "function dialect(outcome: ProviderDialectOutcome, details: AnalysisErrorOptions): AnalysisError { return error; }",
      {
        filename: baselineFile,
        code: "const failure = (cause: unknown): AnalysisError => error;",
      },
    ],
    invalid: [
      {
        code: "const failure = (cause: unknown): AnalysisError => error;",
        errors: [{ messageId: "classifier" }],
      },
      {
        code: "function failure(operation: string, cause: unknown): AnalysisError | undefined { return undefined; }",
        errors: [{ messageId: "classifier" }],
      },
      {
        code: "class Provider { failure(cause: unknown, phase = 'read'): AnalysisError { return error; } }",
        errors: [{ messageId: "classifier" }],
      },
      {
        filename: baselineFile,
        code: "const message = (cause: unknown): string => String(cause);",
        errors: [{ messageId: "stale", data: { allowed: "1", actual: "0" } }],
      },
      {
        filename: baselineFile,
        code: "const a = (cause: unknown): AnalysisError => error; const b = (cause: unknown): AnalysisError => error;",
        errors: [{ messageId: "classifier" }, { messageId: "classifier" }],
      },
    ],
  },
);

it("keeps the classifier baseline to files that still declare one", async () => {
  const baseline = JSON.parse(
    await readFile(
      "scripts/lint/rules/provider-failure-classifier-baseline.json",
      "utf8",
    ),
  ) as Record<string, number>;
  for (const [file, count] of Object.entries(baseline)) {
    expect(file).toMatch(/^src\/.+\.ts$/u);
    expect(count).toBeGreaterThan(0);
    expect(await readFile(file, "utf8")).toMatch(/: unknown\b/u);
  }
});
