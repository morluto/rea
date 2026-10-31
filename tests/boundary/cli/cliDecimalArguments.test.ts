import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { serveCli } from "./cliServeHarness.js";

/**
 * Numeric CLI options parse decimal integer text before Number coercion.
 * Non-decimal spellings must be refused at the input boundary instead of
 * being silently reinterpreted ("" becomes 0, "0x10" becomes 16, "1e3"
 * becomes 1000). Rejections name the field; accepted decimal values reach
 * the operation and fail later, if at all.
 */

const rejectLexicalSpellings = async (
  argv: readonly string[],
  path: string,
): Promise<void> => {
  for (const value of ["0x10", "1e3", ""]) {
    const result = await serveCli([...argv, value, "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      code?: unknown;
      fieldErrors?: { path?: unknown }[];
    };
    expect(result.exitCode, `${path} = ${JSON.stringify(value)}`).toBe(1);
    expect(parsed.code, `${path} = ${JSON.stringify(value)}`).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      parsed.fieldErrors?.some((error) => error.path === path),
      `${path} = ${JSON.stringify(value)}`,
    ).toBe(true);
  }
};

const reachPastValidation = async (argv: readonly string[]): Promise<void> => {
  const result = await serveCli([...argv, "--json"]);
  const parsed = JSON.parse(result.stdout) as { code?: unknown };
  expect(parsed.code, argv.join(" ")).not.toBe("VALIDATION_ERROR");
};

it("refuses non-decimal spellings for numeric read-bytes and search-bytes options", async () => {
  const root = await createTestTempDirectory("rea-cli-decimal-native-");
  const binary = join(root, "probe.bin");
  await writeFile(binary, Buffer.alloc(64, 0x41));
  await rejectLexicalSpellings(
    ["read-bytes", binary, "0", "--length"],
    "length",
  );
  await rejectLexicalSpellings(
    ["search-bytes", binary, "41", "--limit"],
    "limit",
  );
  await reachPastValidation(["read-bytes", binary, "0", "--length", "8"]);
  await reachPastValidation(["search-bytes", binary, "41", "--limit", "5"]);
});

it("refuses non-decimal spellings for pagination options", async () => {
  const root = await createTestTempDirectory("rea-cli-decimal-artifact-");
  const target = join(root, "target.txt");
  await writeFile(target, "not an artifact");
  await rejectLexicalSpellings(
    ["inspect-asset-catalog", target, "--offset"],
    "offset",
  );
  await rejectLexicalSpellings(
    ["inspect-asset-catalog", target, "--limit"],
    "limit",
  );
  await rejectLexicalSpellings(
    ["inspect-keyed-archive", target, "--offset"],
    "offset",
  );
  await rejectLexicalSpellings(
    ["inspect-keyed-archive", target, "--limit"],
    "limit",
  );
  await reachPastValidation(["inspect-asset-catalog", target, "--limit", "5"]);
});

it("refuses non-decimal spellings for sqlite row and deadline options", async () => {
  const root = await createTestTempDirectory("rea-cli-decimal-sqlite-");
  const database = join(root, "probe.sqlite");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  db.close();
  await rejectLexicalSpellings(
    ["inspect-sqlite-database", database, "--row-limit"],
    "rowLimit",
  );
  await rejectLexicalSpellings(
    ["inspect-sqlite-database", database, "--worker-timeout-ms"],
    "workerTimeoutMs",
  );
});

it("refuses non-decimal spellings for adb logcat bounds", async () => {
  await rejectLexicalSpellings(
    ["read-adb-logcat", "serial", "--count"],
    "count",
  );
  await rejectLexicalSpellings(["read-adb-logcat", "serial", "--pid"], "pid");
  await reachPastValidation(["read-adb-logcat", "serial", "--count", "5"]);
});

it("refuses non-decimal spellings for browser observation and frida durations", async () => {
  // Observation windows share the observationDuration guard: blank argv text
  // is refused, non-decimal numeric spellings stay permitted as they are for
  // the inspect-web-page and observe-web-session siblings.
  const blank = await serveCli([
    "discover-webmcp-tools",
    "http://127.0.0.1:9",
    "target",
    "--observation-ms",
    "",
    "--json",
  ]);
  expect(blank.exitCode).toBe(1);
  const blankParsed = JSON.parse(blank.stdout) as {
    code?: unknown;
    fieldErrors?: { path?: unknown }[];
  };
  expect(blankParsed.code).toBe("VALIDATION_ERROR");
  expect(blankParsed.fieldErrors?.some((e) => e.path === "observationMs")).toBe(
    true,
  );
  await rejectLexicalSpellings(
    ["instrument-with-frida", "attach", "4194304", "--duration-ms"],
    "durationMs",
  );
});

it("refuses non-decimal spellings for evm, packet and signal limits", async () => {
  const root = await createTestTempDirectory("rea-cli-decimal-misc-");
  const carrier = join(root, "carrier.txt");
  await writeFile(carrier, "not bytecode");
  await rejectLexicalSpellings(
    ["inspect-evm-interface", carrier, "raw", "--timeout-ms"],
    "timeoutMs",
  );
  await rejectLexicalSpellings(["inspect-packet-fields", "--limit"], "limit");
  await rejectLexicalSpellings(["inspect-signal-decoders", "--limit"], "limit");
});

it("refuses non-decimal spellings for javascript analysis resource bounds", async () => {
  const root = await createTestTempDirectory("rea-cli-decimal-ajs-");
  const application = join(root, "app.js");
  await writeFile(application, "const value = 1;\n");
  for (const [flag, path] of [
    ["--max-semantic-nodes", "maxSemanticNodes"],
    ["--max-semantic-nodes-per-file", "maxSemanticNodesPerFile"],
    ["--max-semantic-unknowns", "maxSemanticUnknowns"],
    ["--max-semantic-unknowns-per-file", "maxSemanticUnknownsPerFile"],
    ["--max-heap-mb", "maxHeapMb"],
    ["--analysis-timeout-ms", "analysisTimeoutMs"],
  ] as const) {
    await rejectLexicalSpellings(
      ["analyze-javascript-application", application, flag],
      path,
    );
  }
});

it("keeps canonical decimal bounds working", async () => {
  const result = await serveCli([
    "inspect-asset-catalog",
    "missing.app",
    "--offset",
    "3",
    "--json",
  ]);
  const parsed = JSON.parse(result.stdout) as { code?: unknown };
  expect(parsed.code).not.toBe("VALIDATION_ERROR");
});
