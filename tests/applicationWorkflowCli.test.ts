import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
} from "../src/contracts/javascriptApplicationWorkflowExamples.js";

const execute = promisify(execFile);

describe("application workflow CLI parity", () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("accepts inline trace JSON and file-backed comparison JSON", async () => {
    const traced = await runCli([
      "trace-application-feature",
      JSON.stringify(JAVASCRIPT_FEATURE_TRACE_EXAMPLE),
      "--json",
    ]);
    expect(traced).toMatchObject({
      operation: "trace_application_feature",
      normalized_result: { schema_version: 1 },
    });

    const root = await mkdtemp(join(tmpdir(), "rea-application-cli-"));
    temporary.push(root);
    const comparisonPath = join(root, "comparison.json");
    await writeFile(
      comparisonPath,
      JSON.stringify(JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE),
    );
    const compared = await runCli([
      "compare-application-versions",
      comparisonPath,
      "--json",
    ]);
    expect(compared).toMatchObject({
      operation: "compare_application_versions",
      normalized_result: {
        schema_version: 1,
        summary: { unknown: expect.any(Number) },
      },
    });
  }, 20_000);

  it("returns safe actionable JSON validation details", async () => {
    const malformed = await runCli([
      "trace-application-feature",
      "{not-json",
      "--json",
    ]);
    expect(malformed).toMatchObject({
      code: "invalid_request",
      retryable: true,
      details: {
        issues: [{ path: [], reason: "invalid_format", expected: "JSON" }],
      },
    });
    expect(JSON.stringify(malformed)).not.toContain("not-json");

    const missing = await runCli(["trace-application-feature", "{}", "--json"]);
    expect(missing).toMatchObject({
      code: "invalid_request",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["application"],
            reason: "missing_argument",
          }),
        ]),
      },
    });

    const missingAppleInventory = await runCli([
      "project-apple-application-graph",
      "{}",
      "--json",
    ]);
    expect(missingAppleInventory).toMatchObject({
      code: "invalid_request",
      remediation: {
        action: "Correct the listed arguments and retry.",
      },
    });

    const missingAndroidInventory = await runCli([
      "project-android-application-graph",
      "{}",
      "--json",
    ]);
    expect(missingAndroidInventory).toMatchObject({
      code: "invalid_request",
      remediation: {
        action: "Correct the listed arguments and retry.",
      },
    });

    const missingRuntimeInventory = await runCli([
      "identify-runtime",
      "{}",
      "--json",
    ]);
    expect(missingRuntimeInventory).toMatchObject({
      code: "invalid_request",
      remediation: {
        action: "Correct the listed arguments and retry.",
      },
    });
  }, 45_000);
});

const runCli = async (arguments_: readonly string[]): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      { cwd: process.cwd(), env: process.env, maxBuffer: 16 * 1_024 * 1_024 },
    );
    return JSON.parse(stdout);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return JSON.parse(cause.stdout);
    throw cause;
  }
};
