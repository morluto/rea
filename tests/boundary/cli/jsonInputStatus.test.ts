import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const JSON_COMMANDS = [
  ["inspect-analysis-view", "inspect_analysis_view"],
  ["trace-application-feature", "trace_application_feature"],
  ["trace-javascript-semantics", "trace_javascript_semantics"],
  ["compare-application-versions", "compare_application_versions"],
  ["compare-source-to-bundle", "compare_source_to_bundle"],
  ["compare-javascript-export-shapes", "compare_javascript_export_shapes"],
  [
    "build-reconstruction-obligation-ledger",
    "build_reconstruction_obligation_ledger",
  ],
  ["evaluate-reconstruction-coverage", "evaluate_reconstruction_coverage"],
  ["project-android-application-graph", "project_android_application_graph"],
  ["project-apple-application-graph", "project_apple_application_graph"],
  ["import-managed-reconstruction", "import_managed_reconstruction"],
  ["verify-managed-native-boundaries", "verify_managed_native_boundaries"],
  ["project-managed-application-graph", "project_managed_application_graph"],
  ["capture-browser-scenario", "capture_browser_scenario"],
  ["capture-electron-scenario", "capture_electron_scenario"],
  ["reconcile-javascript-runtime", "reconcile_javascript_runtime"],
] as const;

describe("compiled CLI JSON input failure status", () => {
  for (const [command, operation] of JSON_COMMANDS)
    cliTest(
      `${command} rejects malformed inline input before dispatch`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-cli-json-status-");
        const input = "{";
        const result = await cli.run({
          arguments: [command, input, "--json"],
          environment: {
            HOME: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
          },
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
            HOME: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
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
        expect(result.stderr).toBe("");
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
      const root = await createTestTempDirectory("rea-cli-json-omitted-");
      const result = await cli.run({
        arguments: [
          command,
          JSON.stringify({ view: { kind: "summary" } }),
          "--json",
        ],
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
        },
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

  // Delivery is chosen by options beside the document; a delivery field in
  // the document names its option instead of being dropped or misread.
  for (const [command, operation, field, message] of [
    [
      "compare-static-and-observed-endpoints",
      "compare_static_and_observed_endpoints",
      "detail",
      "pass --detail beside it",
    ],
    [
      "compare-static-and-observed-endpoints",
      "compare_static_and_observed_endpoints",
      "view",
      "pass --view beside it",
    ],
    [
      "capture-browser-scenario",
      "capture_browser_scenario",
      "detail",
      "pass --detail beside it",
    ],
    [
      "validate-browser-scenario",
      "capture_browser_scenario",
      "detail",
      "pass --detail to capture-browser-scenario",
    ],
  ] as const)
    cliTest(
      `${command} refuses ${field} inside the document`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-cli-json-flagged-");
        const result = await cli.run({
          arguments: [
            command,
            JSON.stringify({
              [field]: field === "view" ? { collection: "matches" } : "summary",
            }),
            "--json",
          ],
          environment: {
            HOME: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
          },
        });
        expect(result.json).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          details: {
            operation,
            issues: [
              { path: [field], message: expect.stringContaining(message) },
            ],
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
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
        },
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
      const root = await createTestTempDirectory("rea-cli-json-url-path-");
      const result = await cli.run({
        arguments: [
          "compare-source-to-bundle",
          JSON.stringify({
            reference: { kind: "file", path: "file:ref.json" },
            application: {},
          }),
          "--json",
        ],
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
        },
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
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
        },
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
      const root = await createTestTempDirectory("rea-cli-json-overlong-");
      const input = `[${"x".repeat(3_000)}`;
      const result = await cli.run({
        arguments: ["compare-javascript-export-shapes", input, "--json"],
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
        },
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
      const root = await createTestTempDirectory("rea-cli-json-overlong-path-");
      const input = `[${"x".repeat(3_000)}.json`;
      const result = await cli.run({
        arguments: ["compare-javascript-export-shapes", input, "--json"],
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
        },
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
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
        },
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
          environment: {
            HOME: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
          },
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
            `import { parseCliJsonInput } from "./dist/cli/cliJsonInput.js";
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

describe("compiled CLI parser with relative brace and bracket paths", () => {
  for (const filename of ["[input].json", "{capture}.json"])
    cliTest(
      `reads the selected relative file ${filename}`,
      async ({ processes }) => {
        const root = await createTestTempDirectory("rea-cli-json-path-");
        const value = { selected: filename };
        await writeFile(join(root, filename), JSON.stringify(value));
        const moduleUrl = new URL(
          "../../../dist/cli/cliJsonInput.js",
          import.meta.url,
        ).href;
        const result = await processes.run(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { parseCliJsonInput } from ${JSON.stringify(moduleUrl)};
           console.log(JSON.stringify(await parseCliJsonInput(process.argv[1], "test-input")));`,
            filename,
          ],
          {
            cwd: root,
            env: {
              HOME: root,
              XDG_CONFIG_HOME: root,
              XDG_CACHE_HOME: root,
            },
          },
        );

        expect(result.stdout).toBe(`${JSON.stringify({ ok: true, value })}\n`);
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      },
    );

  for (const filename of ["[missing].json", "{missing}.json"])
    cliTest(
      `keeps missing relative path diagnostics for ${filename}`,
      async ({ processes }) => {
        const root = await createTestTempDirectory("rea-cli-json-missing-");
        const moduleUrl = new URL(
          "../../../dist/cli/cliJsonInput.js",
          import.meta.url,
        ).href;
        const result = await processes.run(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { parseCliJsonInput } from ${JSON.stringify(moduleUrl)};
           console.log(JSON.stringify(await parseCliJsonInput(process.argv[1], "test-input")));`,
            filename,
          ],
          {
            cwd: root,
            env: {
              HOME: root,
              XDG_CONFIG_HOME: root,
              XDG_CACHE_HOME: root,
            },
          },
        );

        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          ok: false,
          error: { input_path: filename, input_reason: "read-failed" },
        });
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      },
    );
});
