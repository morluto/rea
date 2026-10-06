import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { parseCliJsonInput } from "../../../src/cliJsonInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const JSON_COMMANDS = [
  ["trace-application-feature", "trace-application-feature"],
  ["trace-javascript-semantics", "trace-javascript-semantics"],
  ["compare-application-versions", "compare-application-versions"],
  ["compare-source-to-bundle", "compare-source-to-bundle"],
  ["compare-javascript-export-shapes", "compare-javascript-export-shapes"],
  [
    "build-reconstruction-obligation-ledger",
    "build-reconstruction-obligation-ledger",
  ],
  ["evaluate-reconstruction-coverage", "evaluate-reconstruction-coverage"],
  ["import-managed-reconstruction", "import-managed-reconstruction"],
  ["verify-managed-native-boundaries", "verify-managed-native-boundaries"],
  ["project-managed-application-graph", "project-managed-application-graph"],
  ["capture-browser-scenario", "capture_browser_scenario"],
  ["capture-electron-scenario", "capture_electron_scenario"],
  ["reconcile-javascript-runtime", "reconcile_javascript_runtime"],
] as const;

describe("compiled CLI JSON input failure status", () => {
  for (const [command, operation] of JSON_COMMANDS)
    for (const kind of ["inline", "file", "missing"] as const)
      cliTest(
        `${command} rejects malformed or unreadable ${kind} input before dispatch`,
        async ({ cli }) => {
          const root = await createTestTempDirectory("rea-cli-json-status-");
          const input = kind === "inline" ? "{" : join(root, "input.json");
          if (kind === "file") await writeFile(input, "{");
          const parsed = await parseCliJsonInput(input, operation);
          if (parsed.ok)
            throw new Error("Expected JSON input to fail before dispatch");

          const result = await cli.run({
            arguments: [command, input, "--json"],
            environment: {
              HOME: root,
              XDG_CONFIG_HOME: root,
              XDG_CACHE_HOME: root,
            },
          });

          expect(result.stdout).toBe(
            `${JSON.stringify(parsed.error, null, 2)}\n`,
          );
          expect(result.json).toMatchObject({
            code: "invalid_request",
            category: "invalid_input",
            ...(kind === "missing" ? {} : { details: { operation } }),
            ...(kind === "inline"
              ? {}
              : {
                  input_path: input,
                  input_reason:
                    kind === "file" ? "invalid-json" : "read-failed",
                }),
          });
          expect(result.stderr).toBe("");
          expect(result.exitCode).toBe(1);
        },
      );

  for (const [format, flags] of [
    ["JSON", ["--json"]],
    ["JSONL", ["--format", "jsonl"]],
    ["YAML", ["--format", "yaml"]],
    ["default", []],
  ] as const)
    cliTest(
      `keeps the failure status with ${format} output`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-cli-json-format-");
        const input = join(root, "missing.json");
        const result = await cli.run({
          arguments: ["compare-javascript-export-shapes", input, ...flags],
          environment: {
            HOME: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
          },
        });
        for (const diagnostic of [
          "invalid_request",
          "invalid_input",
          input,
          "read-failed",
        ])
          expect(result.stdout).toContain(diagnostic);
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(1);
      },
    );

  cliTest(
    "rejects an empty file path without losing its diagnostic",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-cli-json-empty-");
      const result = await cli.run({
        arguments: ["compare-javascript-export-shapes", "", "--json"],
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
        },
      });
      expect(result.json).toMatchObject({
        code: "invalid_request",
        input_path: "",
        input_reason: "read-failed",
      });
      expect(result.exitCode).toBe(1);
    },
  );
});

describe("compiled JSON parser and logger success seam", () => {
  for (const kind of ["inline", "file"] as const)
    cliTest(
      `preserves valid ${kind} data and a zero exit status without running a workflow`,
      async ({ processes }) => {
        const root = await createTestTempDirectory("rea-cli-json-success-");
        const value = {
          error: "source data",
          code: "invalid_request",
          values: [null, false, 0],
        };
        const json = JSON.stringify(value);
        const input = kind === "inline" ? json : join(root, "input.json");
        if (kind === "file") await writeFile(input, json);
        const result = await processes.run(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { parseCliJsonInput } from "./dist/cliJsonInput.js";
         import { logCliCommand } from "./dist/cliLogging.js";
         import { silentLogger } from "./dist/logger.js";
         const parsed = await parseCliJsonInput(process.argv[1], "test-input");
         const output = await logCliCommand(silentLogger, "test-input", async () =>
           parsed.ok ? parsed.value : parsed.error);
         console.log(JSON.stringify(output));`,
            input,
          ],
          { env: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root } },
        );
        expect(result.stdout).toBe(`${json}\n`);
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      },
    );
});
