import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decode as decodeToon } from "@toon-format/toon";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { parse as parseYaml } from "yaml";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

let isolatedHomeRoot = "";
let isolatedHomeEnvironment: NodeJS.ProcessEnv = {};

beforeAll(async () => {
  isolatedHomeRoot = (await createTestWorkspace("rea-cli-json-isolated-home-"))
    .root;
  isolatedHomeEnvironment = {
    HOME: isolatedHomeRoot,
    XDG_CONFIG_HOME: isolatedHomeRoot,
    XDG_CACHE_HOME: isolatedHomeRoot,
  };
});

afterAll(async () => {
  if (isolatedHomeRoot !== "") await removeTestWorkspace(isolatedHomeRoot);
});

describe("compiled CLI JSON input failure status", () => {
  // Analysis view owns its input. Export shape comparison uses the shared
  // contract document command.
  for (const [command, operation] of [
    ["inspect-adb-ui", "inspect_adb_ui"],
    ["inspect-analysis-view", "inspect_analysis_view"],
    ["compare-javascript-export-shapes", "compare_javascript_export_shapes"],
  ] as const)
    cliTest(
      `${command} rejects malformed inline input before dispatch`,
      async ({ cli }) => {
        const input = "{";
        const result = await cli.run({
          arguments: [command, input, "--json"],
          environment: isolatedHomeEnvironment,
        });

        expect(result.json).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          details: {
            operation,
            issues: [{ path: [], reason: "invalid_format", expected: "JSON" }],
          },
        });
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(1);
      },
    );

  for (const kind of ["file", "missing"] as const)
    cliTest(
      `preserves ${kind} JSON input diagnostics through a real command`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-cli-json-status-");
        const input = join(root, "input.json");
        if (kind === "file") await writeFile(input, "{");

        const result = await cli.run({
          arguments: ["compare-javascript-export-shapes", input, "--json"],
          environment: {
            ...isolatedHomeEnvironment,
            ...(kind === "file" ? { REA_LOG_LEVEL: "info" } : {}),
          },
        });

        expect(result.json).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          input_path: input,
          input_reason: kind === "file" ? "invalid-json" : "read-failed",
          ...(kind === "file"
            ? { details: { operation: "compare_javascript_export_shapes" } }
            : {}),
        });
        if (kind === "file") {
          const logs = result.stderr
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as unknown);
          expect(logs).toContainEqual(
            expect.objectContaining({
              command: "compare-javascript-export-shapes",
              status: "error",
              level: 50,
              msg: "CLI command failed",
            }),
          );
        } else {
          expect(result.stderr).toBe("");
        }
        expect(result.exitCode).toBe(1);
      },
    );
});

describe("compiled CLI JSON document omissions", () => {
  // A one-shot command retains no session Evidence, so a selected view would
  // otherwise reach an owner that accepts it and be silently dropped.
  for (const [command, operation] of [
    ["compare-source-to-bundle", "compare_source_to_bundle"],
    ["trace-application-feature", "trace_application_feature"],
  ] as const)
    cliTest(`${command} refuses an omitted view field`, async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          command,
          JSON.stringify({ view: { kind: "summary" } }),
          "--json",
        ],
        environment: isolatedHomeEnvironment,
      });
      expect(result.json).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: {
          operation,
          issues: [
            {
              path: ["view"],
              message: expect.stringContaining("inspect-analysis-view"),
            },
          ],
        },
      });
      expect(result.exitCode).toBe(1);
    });

  // Delivery fields belong beside the document. The endpoints command
  // reports both misplacements together, while validation points to capture.
  for (const { command, operation, document, hints } of [
    {
      command: "compare-static-and-observed-endpoints",
      operation: "compare_static_and_observed_endpoints",
      document: { detail: "summary", view: { collection: "matches" } },
      hints: {
        detail: "pass --detail beside it",
        view: "pass --view beside it",
      },
    },
    {
      command: "capture-browser-scenario",
      operation: "capture_browser_scenario",
      document: { detail: "summary" },
      hints: { detail: "pass --detail beside it" },
    },
    {
      command: "validate-browser-scenario",
      operation: "capture_browser_scenario",
      document: { detail: "summary" },
      hints: { detail: "pass --detail to capture-browser-scenario" },
    },
  ])
    cliTest(
      `${command} reports each misplaced delivery field`,
      async ({ cli }) => {
        const result = await cli.run({
          arguments: [command, JSON.stringify(document), "--json"],
          environment: isolatedHomeEnvironment,
        });
        expect(result.json).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          details: {
            operation,
            issues: Object.entries(hints).map(([field, message]) => ({
              path: [field],
              message: expect.stringContaining(message),
            })),
          },
        });
        expect(result.exitCode).toBe(1);
      },
    );
});

describe("compiled CLI JSON document admission order", () => {
  // The document frame is checked before any Evidence bundle is read, so a
  // missing bundle cannot hide document errors.
  cliTest(
    "compare-static-and-observed-endpoints refuses a malformed document before reading its bundle",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-cli-json-frame-");
      const result = await cli.run({
        arguments: [
          "compare-static-and-observed-endpoints",
          "{}",
          "--evidence-bundle",
          join(root, "missing.bundle.json"),
          "--json",
        ],
        environment: isolatedHomeEnvironment,
      });
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "compare_static_and_observed_endpoints",
          issues: expect.arrayContaining([
            expect.objectContaining({ path: ["application"] }),
            expect.objectContaining({ path: ["capture"] }),
          ]),
        },
      });
      expect(JSON.stringify(result.json)).not.toContain("missing.bundle.json");
      expect(result.exitCode).toBe(1);
    },
  );
});

describe("compiled CLI JSON document caller paths", () => {
  // A `file:` spelling is a URL, never resolved against the working directory
  // (#2577); a caller names such a file as `./file:ref.json`.
  cliTest(
    "compare-source-to-bundle refuses a file URL reference path",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          "compare-source-to-bundle",
          JSON.stringify({
            reference: { kind: "file", path: "file:ref.json" },
            application: {},
          }),
          "--json",
        ],
        environment: isolatedHomeEnvironment,
      });
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "compare_source_to_bundle",
          issues: [{ path: ["reference", "path"], reason: "invalid_format" }],
        },
      });
      expect(result.exitCode).toBe(1);
    },
  );
});

describe("compiled CLI session-target JSON documents", () => {
  cliTest(
    "observe-native-calls refuses an invalid document before opening its target",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-cli-json-target-");
      const result = await cli.run({
        arguments: [
          "observe-native-calls",
          join(root, "missing-target"),
          JSON.stringify({ breakpoints: "main" }),
          "--json",
        ],
        environment: isolatedHomeEnvironment,
      });
      expect(result.json).toMatchObject({
        error: "Analysis failed",
        code: "invalid_request",
        details: {
          operation: "observe_native_calls",
          issues: expect.arrayContaining([
            expect.objectContaining({ path: ["breakpoints"] }),
          ]),
        },
      });
      expect(result.exitCode).toBe(1);
    },
  );
});

describe("compiled CLI JSON input diagnostic preservation", () => {
  for (const [format, flags, decode] of [
    ["JSONL", ["--format", "jsonl"], JSON.parse],
    ["YAML", ["--format", "yaml"], parseYaml],
    ["default", [], decodeToon],
  ] as const)
    cliTest(
      `keeps the failure status with ${format} output`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-cli-json-format-");
        const input = join(root, "missing.json");
        const result = await cli.run({
          arguments: ["compare-javascript-export-shapes", input, ...flags],
          environment: isolatedHomeEnvironment,
        });
        const failure = { code: "invalid_request", category: "invalid_input" };
        const details = { input_path: input, input_reason: "read-failed" };
        expect(decode(result.stdout)).toMatchObject(
          format === "JSONL"
            ? {
                $rea: "jsonl/v1",
                type: "error",
                ok: false,
                result: { ...failure, details },
              }
            : { ...failure, ...details },
        );
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(1);
      },
    );

  cliTest(
    "rejects an empty file path without losing its diagnostic",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: ["compare-javascript-export-shapes", "", "--json"],
        environment: isolatedHomeEnvironment,
      });
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        code: "invalid_request",
        input_path: "",
        input_reason: "read-failed",
      });
      expect(result.exitCode).toBe(1);
    },
  );

  cliTest(
    "classifies an overlong malformed inline value before dispatch",
    async ({ cli }) => {
      const input = `[${"x".repeat(3_000)}`;
      const result = await cli.run({
        arguments: ["compare-javascript-export-shapes", input, "--json"],
        environment: isolatedHomeEnvironment,
      });

      expect(result.json).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: {
          operation: "compare_javascript_export_shapes",
          issues: [{ path: [], reason: "invalid_format", expected: "JSON" }],
        },
      });
      expect(result.json).not.toHaveProperty("input_path");
      expect(result.stdout).not.toContain("read-failed");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(1);
    },
  );

  cliTest(
    "preserves explicit overlong JSON path diagnostics",
    async ({ cli }) => {
      const input = `[${"x".repeat(3_000)}.json`;
      const result = await cli.run({
        arguments: ["compare-javascript-export-shapes", input, "--json"],
        environment: isolatedHomeEnvironment,
      });

      expect(result.json).toMatchObject({
        code: "invalid_request",
        input_path: input,
        input_reason: "read-failed",
      });
      expect(result.exitCode).toBe(1);
    },
  );
});

describe("compiled CLI JSON path ambiguity", () => {
  cliTest(
    "classifies malformed inline JSON when a path prefix is a regular file",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-cli-json-not-dir-");
      await writeFile(join(root, "[prefix"), "regular file");
      const input = "[prefix/rest";
      const result = await cli.run({
        arguments: ["capture-browser-scenario", input, "--json"],
        cwd: root,
        environment: isolatedHomeEnvironment,
      });

      expect(result.json).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: {
          operation: "capture_browser_scenario",
          issues: [{ path: [], reason: "invalid_format", expected: "JSON" }],
        },
      });
      expect(result.json).not.toHaveProperty("input_path");
      expect(result.stdout).not.toContain("read-failed");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(1);
    },
  );

  cliTest.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "preserves permission errors for malformed path-like JSON input",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-cli-json-denied-");
      const denied = join(root, "[locked");
      const input = "[locked/rest";
      await mkdir(denied);
      await chmod(denied, 0);
      try {
        await expect(readFile(join(root, input))).rejects.toMatchObject({
          code: "EACCES",
        });
        const result = await cli.run({
          arguments: ["capture-browser-scenario", input, "--json"],
          cwd: root,
          environment: isolatedHomeEnvironment,
        });

        expect(result.json).toMatchObject({
          code: "access_denied",
          input_path: input,
          input_reason: "read-failed",
          details: {
            operation: "capture_browser_scenario",
            path: input,
            system_code: "EACCES",
            boundary: "filesystem-read",
          },
        });
        expect(result.exitCode).toBe(1);
      } finally {
        await chmod(denied, 0o700);
      }
    },
  );
});
