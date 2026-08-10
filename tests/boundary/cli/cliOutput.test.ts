import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

import {
  renderCliOutputArgumentError,
  sanitizeCliOutput,
  validateCliOutputArguments,
} from "../../../src/cliOutput.js";

const CLI_INTEGRATION_TIMEOUT_MS = 60_000;
const CLI_VARIANT_TIMEOUT_MS = 120_000;

describe("CLI output argument and sanitization boundary", () => {
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

  it("preserves normal output and sanitizes text and JSON validation errors", () => {
    expect(sanitizeCliOutput("result: ok\n")).toBe("result: ok\n");
    expect(sanitizeCliOutput("result: VALIDATION_ERROR\n")).toBe(
      "result: VALIDATION_ERROR\n",
    );
    const raw =
      'code: VALIDATION_ERROR\nmessage: "raw Zod details"\nfieldErrors: SECRET\n';
    expect(sanitizeCliOutput(raw)).toBe(
      'code: VALIDATION_ERROR\nmessage: "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again."\n',
    );
    expect(
      JSON.parse(
        sanitizeCliOutput(
          JSON.stringify({
            code: "VALIDATION_ERROR",
            message: "raw Zod details",
            fieldErrors: [{ code: "invalid_type" }],
          }),
        ),
      ),
    ).toEqual({
      code: "VALIDATION_ERROR",
      message:
        "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again.",
    });
    expect(
      JSON.parse(
        sanitizeCliOutput(
          JSON.stringify({
            ok: false,
            error: {
              code: "VALIDATION_ERROR",
              message: "raw Zod details",
              fieldErrors: [{ code: "invalid_type" }],
            },
            meta: { command: "analyze" },
          }),
        ),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message:
          "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again.",
      },
      meta: { command: "analyze" },
    });
  });
});

describe("compiled CLI output boundary", () => {
  workspaceCliTest(
    "sanitizes a real missing-argument dispatcher failure",
    async ({ cli }) => {
      const ordinary = await cli.run({ arguments: ["analyze"] });
      expect(ordinary).toMatchObject({
        exitCode: 1,
        stdout:
          'code: VALIDATION_ERROR\nmessage: "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again."\n',
      });
      const json = await cli.run({
        arguments: ["--full-output", "--json", "analyze"],
      });
      expect(json).toMatchObject({
        exitCode: 1,
        stdout: expect.not.stringContaining("fieldErrors"),
      });
      const yaml = await cli.run({
        arguments: ["--full-output", "analyze"],
      });
      expect(yaml).toMatchObject({
        exitCode: 1,
        stdout:
          'ok: false\nerror:\n  code: VALIDATION_ERROR\n  message: "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again."\n',
      });
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "preserves artifact diagnostics in ordinary and full JSON output",
    async ({ cli, workspace }) => {
      const source = workspace.path("source");
      await mkdir(source);
      await writeFile(join(source, "main.js"), "console.log('ok');\n");
      const archive = workspace.path("fixture.asar");
      await createPackageWithOptions(source, archive, { unpack: "*.js" });
      await writeFile(join(`${archive}.unpacked`, "main.js"), "changed();\n");

      for (const flags of [["--json"], ["--full-output", "--json"]]) {
        const result = await cli.run({
          arguments: [...flags, "inventory-artifact", archive],
        });
        expect(result.exitCode).toBe(1);
        const output = JSON.stringify(result.json);
        expect(output).toContain('"logical_path":"main.js"');
        expect(output).toMatch(/"declared_sha256":"[a-f0-9]{64}"/u);
        expect(output).toMatch(/"calculated_sha256":"[a-f0-9]{64}"/u);
        expect(output).toContain('"unpacked":true');
      }
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "keeps operation failure status independent of output controls",
    async ({ cli }) => {
      const variants = [
        ["--format", "toon"],
        ["--format", "json"],
        ["--format", "yaml"],
        ["--format", "md"],
        ["--format", "jsonl"],
        ["--full-output", "--json"],
        ["--filter-output", "category", "--json"],
        ["--token-limit", "5", "--json"],
        ["--token-count", "--json"],
      ];

      for (const flags of variants) {
        const result = await cli.run({
          arguments: [
            ...flags,
            "investigate-versions",
            "/tmp/left",
            "/tmp/right",
            "/tmp/workspace.json",
          ],
        });
        expect(result).toMatchObject({
          exitCode: 1,
          stdout: expect.any(String),
        });
      }
    },
    CLI_VARIANT_TIMEOUT_MS,
  );

  workspaceCliTest(
    "keeps failure logs out of structured stdout",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          "--json",
          "investigate-versions",
          "/tmp/left",
          "/tmp/right",
          "/tmp/workspace.json",
        ],
        environment: { REA_LOG_LEVEL: "error" },
      });
      expect(result).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining('"status":"error"'),
      });
      expect(result.json).toMatchObject({ error: "ApprovalRequired" });
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );
});
