import { expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRuleTester } from "../support/createRuleTester.js";
import rule from "../../scripts/lint/rules/provider-failure-classifier.mjs";

/** A baselined file allowed exactly one per-site classifier. */
const baselinedFile = fileURLToPath(
  new URL("../../src/rust/RustBinaryProvider.ts", import.meta.url),
);
/** The shared classifier owner, which may examine raw failures. */
const ownerFile = fileURLToPath(
  new URL("../../src/providers/classifyProviderFailure.ts", import.meta.url),
);
const classifier = "const failure = (cause: unknown): AnalysisError => error;";

createRuleTester().run("provider-failure-classifier", rule, {
  valid: [
    "const classify = (outcome: ProviderOutcome): AnalysisError => error;",
    "const message = (cause: unknown): string => String(cause);",
    "const recover = (cause: unknown): Result<number, AnalysisError> => ok(1);",
    "function dialect(outcome: ProviderDialectOutcome, details: AnalysisErrorOptions): AnalysisError { return error; }",
    { code: classifier, filename: baselinedFile },
    { code: classifier, filename: ownerFile },
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
});

it("keeps the classifier baseline to existing source files", async () => {
  const baseline = JSON.parse(
    await readFile(
      "scripts/lint/rules/provider-failure-classifier-baseline.json",
      "utf8",
    ),
  ) as { owners: string[]; counts: Record<string, number> };
  for (const owner of baseline.owners)
    expect((await stat(owner)).isFile(), owner).toBe(true);
  for (const [file, count] of Object.entries(baseline.counts)) {
    expect(file).toMatch(/^src\/.+\.ts$/u);
    expect(count).toBeGreaterThan(0);
    // The lint run reports an entry above a file's real count as stale; this
    // catches entries whose file no longer exists, which lint never visits.
    expect((await stat(file)).isFile(), file).toBe(true);
  }
});
