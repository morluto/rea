import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

import {
  renderCliOutputArgumentError,
  renderEmptyFilteredCliOutput,
  validateCliOutputArguments,
} from "../../../src/cliOutput.js";

const CLI_INTEGRATION_TIMEOUT_MS = 60_000;

describe("CLI output argument boundary", () => {
  it("rejects token windows that would corrupt structured output", () => {
    for (const format of ["json", "jsonl", "yaml"] as const) {
      const validation = validateCliOutputArguments([
        "providers",
        "--token-limit",
        "5",
        "--format",
        format,
      ]);
      expect(validation).toMatchObject({
        ok: false,
        format,
        code: "UNSUPPORTED_OUTPUT_COMBINATION",
      });
      if (!validation.ok) {
        const rendered = renderCliOutputArgumentError(validation);
        expect(rendered).not.toContain("[truncated:");
        if (format === "json" || format === "jsonl")
          expect(JSON.parse(rendered)).toMatchObject({
            ok: false,
            error: { code: "UNSUPPORTED_OUTPUT_COMBINATION" },
          });
        else
          expect(rendered).toMatch(
            /^ok: false\nerror:\n  code: UNSUPPORTED_OUTPUT_COMBINATION\n/u,
          );
      }
    }
    expect(
      validateCliOutputArguments([
        "providers",
        "--token-limit",
        "5",
        "--format",
        "toon",
      ]),
    ).toEqual({ ok: true });
    expect(
      validateCliOutputArguments(["providers", "--token-count", "--json"]),
    ).toEqual({ ok: true });
  });
});

describe("CLI output valued-flag parsing", () => {
  workspaceCliTest(
    "preserves complete JSON errors when native builtin flags follow unusual arguments",
    async ({ cli }) => {
      for (const arguments_ of [
        ["providers", "--", "--json", "--token-limit", "5"],
        ["providers", "--json", "--format=toon", "--token-limit", "5"],
      ]) {
        const result = await cli.run({ arguments: arguments_ });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain("[truncated:");
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: "UNSUPPORTED_OUTPUT_COMBINATION" },
        });
      }
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "fails before emitting a truncated JSON document",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: ["providers", "--token-limit", "5", "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "UNSUPPORTED_OUTPUT_COMBINATION" },
      });
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "does not treat empty or equals-style output values as active builtins",
    async ({ cli }) => {
      for (const arguments_ of [
        ["capabilities", "--json", "--format", ""],
        ["capabilities", "--json", "--filter-output", ""],
        ["capabilities", "--json", "--token-limit", ""],
        ["capabilities", "--json", "--token-limit=5"],
      ]) {
        const result = await cli.run({ arguments: arguments_ });
        expect(result.exitCode).toBe(1);
        expect(result.json).toBeDefined();
        expect(result.stdout).not.toContain("[truncated:");
        expect(JSON.stringify(result.json)).not.toContain(
          "UNSUPPORTED_OUTPUT_COMBINATION",
        );
      }
      const validTokenWindow = await cli.run({
        arguments: ["capabilities", "--json", "--token-limit", "5"],
      });
      expect(validTokenWindow.exitCode).toBe(1);
      expect(validTokenWindow.json).toMatchObject({
        ok: false,
        error: { code: "UNSUPPORTED_OUTPUT_COMBINATION" },
      });
      const emptyFormatWithTokenWindow = await cli.run({
        arguments: [
          "capabilities",
          "--json",
          "--format",
          "",
          "--token-limit",
          "5",
        ],
      });
      expect(emptyFormatWithTokenWindow.exitCode).toBe(1);
      expect(emptyFormatWithTokenWindow.stdout).not.toContain("[truncated:");
      expect(emptyFormatWithTokenWindow.json).toMatchObject({
        ok: false,
        error: { code: "UNSUPPORTED_OUTPUT_COMBINATION" },
      });

      for (const arguments_ of [
        ["capabilities", "--json", "--token-limit", "not-a-number"],
        [
          "capabilities",
          "--format",
          "unsupported-format",
          "--json",
          "--token-limit",
          "5",
        ],
      ]) {
        const result = await cli.run({ arguments: arguments_ });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain("UNSUPPORTED_OUTPUT_COMBINATION");
        expect(result.stdout).not.toContain("[truncated:");
      }
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );
});

describe("CLI output argument boundary", () => {
  it("renders an explicit empty projection for structured filtered output", () => {
    for (const format of ["json", "jsonl", "yaml"])
      expect(
        renderEmptyFilteredCliOutput([
          "providers",
          "--format",
          format,
          "--filter-output",
          "missing",
        ]),
      ).toBe("{}\n");
    expect(
      renderEmptyFilteredCliOutput(["providers", "--filter-output", "missing"]),
    ).toBeUndefined();
    expect(
      renderEmptyFilteredCliOutput(["providers", "--format", "json"]),
    ).toBeUndefined();
  });
});

describe("compiled CLI output boundary", () => {
  workspaceCliTest(
    "emits valid JSON when an output filter misses the top-level result",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          "analyze-javascript-application",
          "tests/conformance/readiness/javascript-cli",
          "--format",
          "json",
          "--filter-output",
          "summary",
        ],
      });
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "{}\n",
        stderr: expect.stringContaining('"rea_progress":'),
        json: {},
      });
      const nested = await cli.run({
        arguments: [
          "analyze-javascript-application",
          "tests/conformance/readiness/javascript-cli",
          "--format",
          "json",
          "--filter-output",
          "normalized_result.not_a_field",
        ],
      });
      expect(nested).toMatchObject({
        exitCode: 0,
        stderr: expect.stringContaining('"rea_progress":'),
        json: { normalized_result: {} },
      });
      const selected = await cli.run({
        arguments: [
          "analyze-javascript-application",
          "tests/conformance/readiness/javascript-cli",
          "--format",
          "json",
          "--filter-output",
          "normalized_result.summary",
        ],
      });
      expect(selected).toMatchObject({
        exitCode: 0,
        stderr: expect.stringContaining('"rea_progress":'),
        json: {
          normalized_result: {
            summary: expect.objectContaining({ browser_windows: 0 }),
          },
        },
      });
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "preserves missing-argument coordinates through every dispatcher formatter",
    async ({ cli }) => {
      const json = await cli.run({ arguments: ["--json", "analyze"] });
      expect(json).toMatchObject({
        exitCode: 1,
        json: {
          code: "VALIDATION_ERROR",
          message: expect.stringContaining("expected string"),
          fieldErrors: [
            {
              path: "path",
              code: "invalid_type",
              missing: true,
              expected: "string",
            },
          ],
        },
      });
      for (const arguments_ of [
        ["analyze"],
        ["--format", "yaml", "analyze"],
        ["--full-output", "analyze"],
      ]) {
        const result = await cli.run({ arguments: arguments_ });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("VALIDATION_ERROR");
        expect(result.stdout).toContain("fieldErrors");
        expect(result.stdout).toContain("path");
        expect(result.stdout).toContain("expected string");
      }
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "preserves invalid option names and enum constraints in structured diagnostics",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          "search",
          "/caller/local/input",
          "needle",
          "--kind",
          "unrecognized",
          "--json",
        ],
      });
      expect(result).toMatchObject({
        exitCode: 1,
        json: {
          code: "VALIDATION_ERROR",
          fieldErrors: [
            {
              path: "kind",
              code: "invalid_value",
              missing: false,
              message: expect.stringContaining('"strings"|"procedures"'),
            },
          ],
        },
      });
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "prints field-specific missing-argument recovery in terminal mode",
    async ({ processes }) => {
      const result = await processes.run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            'import { createCli } from "./dist/cli.js";',
            'Object.defineProperty(process.stdout, "isTTY", { value: true });',
            'await createCli({}).serve(["analyze"], { exit: (code) => { process.exitCode = code; } });',
          ].join("\n"),
        ],
        { cwd: process.cwd() },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        "Error: missing required argument <path>",
      );
      expect(result.stdout).toContain("See below for usage.");
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );
});

describe("compiled CLI artifact diagnostics", () => {
  workspaceCliTest(
    "preserves artifact diagnostics in JSON output",
    async ({ cli, workspace }) => {
      const source = workspace.path("source");
      await mkdir(source);
      await writeFile(join(source, "main.js"), "console.log('ok');\n");
      const archive = workspace.path("fixture.asar");
      await createPackageWithOptions(source, archive, { unpack: "*.js" });
      await writeFile(join(`${archive}.unpacked`, "main.js"), "changed();\n");

      const result = await cli.run({
        arguments: ["--json", "inspect-artifact", archive],
      });
      expect(result.exitCode).toBe(1);
      const output = JSON.stringify(result.json);
      expect(output).toContain('"logical_path":"main.js"');
      expect(output).toMatch(/"declared_sha256":"[a-f0-9]{64}"/u);
      expect(output).toMatch(/"calculated_sha256":"[a-f0-9]{64}"/u);
      expect(output).toContain('"unpacked":true');
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );
});
