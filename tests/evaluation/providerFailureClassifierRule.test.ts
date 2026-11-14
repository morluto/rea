import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import rule from "../../scripts/lint/rules/provider-failure-classifier.mjs";

/** A baselined file allowed exactly one per-site classifier. */
const baselinedFile = fileURLToPath(
  new URL("../../src/adb/AdbProvider.ts", import.meta.url),
);
const classifier = "const failure = (cause: unknown): AnalysisError => error;";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "provider-failure-classifier",
  rule,
  {
    valid: [
      "const classify = (outcome: ProviderOutcome): AnalysisError => error;",
      "const message = (cause: unknown): string => String(cause);",
      "const recover = (cause: unknown): Result<number, AnalysisError> => ok(1);",
      "function dialect(outcome: ProviderDialectOutcome, details: AnalysisErrorOptions): AnalysisError { return error; }",
      { code: classifier, filename: baselinedFile },
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
        code: `${classifier}\n${classifier.replace("failure", "second")}`,
        filename: baselinedFile,
        errors: [{ messageId: "classifier" }, { messageId: "classifier" }],
      },
      {
        code: "const message = (cause: unknown): string => String(cause);",
        filename: baselinedFile,
        errors: [{ messageId: "stale", data: { allowed: "1", actual: "0" } }],
      },
    ],
  },
);

it("keeps the classifier baseline to existing source files", async () => {
  const baseline = JSON.parse(
    await readFile(
      "scripts/lint/rules/provider-failure-classifier-baseline.json",
      "utf8",
    ),
  ) as Record<string, number>;
  for (const [file, count] of Object.entries(baseline)) {
    expect(file).toMatch(/^src\/.+\.ts$/u);
    expect(count).toBeGreaterThan(0);
    // The lint run reports an entry above a file's real count as stale; this
    // catches entries whose file no longer exists, which lint never visits.
    await expect(readFile(file, "utf8")).resolves.toBeTypeOf("string");
  }
});
