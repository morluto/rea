import { chmod, mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  analysisCliErrorEnvelopeSchema,
  analysisErrorProjectionSchema,
} from "../../../src/contracts/errorSchemas.js";
import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  REFERENCE_SOURCE_MAX_BYTES,
  REFERENCE_SOURCE_METADATA_MAX_BYTES,
} from "../../../src/reference/ReferenceSourceLimits.js";

const unsupportedHostOutput = expect.objectContaining({
  error: "Import failed",
  category: "unsupported_provider",
  message: expect.stringContaining(
    "Safe no-follow file opens are unavailable on this host.",
  ),
});

const permissionChecksUnavailable =
  process.platform === "win32" || process.getuid?.() === 0;

cliTest.skipIf(process.platform === "win32")(
  "classifies a sparse oversized source as a resource limit",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-reference-cli-limit-");
    const path = join(root, "large.js");
    await writeFile(path, "");
    await truncate(path, REFERENCE_SOURCE_MAX_BYTES + 1);

    const result = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
      cwd: root,
    });

    expect(result.json).toMatchObject({
      error: "Import failed",
      code: "resource_constraint",
      category: "resource_constraint",
      details: {
        diagnostics: {
          reference_source_code: "limit",
          partial: {
            bytesRead: 0,
            entries: [{ path: "large.js", code: "limit" }],
          },
        },
      },
    });
    expect(result.exitCode).toBe(1);
  },
);

cliTest.skipIf(process.platform === "win32")(
  "keeps aggregate-limit partial inventory JSON-safe",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-reference-cli-total-limit-",
    );
    for (const name of ["a.js", "b.js"]) {
      const path = join(root, name);
      await writeFile(path, "");
      await truncate(path, REFERENCE_SOURCE_MAX_BYTES / 2 + 1);
    }

    const result = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
      cwd: root,
    });

    expect(result.json).toMatchObject({
      error: "Import failed",
      code: "resource_constraint",
      category: "resource_constraint",
      details: {
        diagnostics: {
          reference_source_code: "limit",
          partial: {
            bytesRead: REFERENCE_SOURCE_MAX_BYTES / 2 + 1,
            entries: expect.arrayContaining([
              expect.objectContaining({
                status: "read",
                kind: "file",
                size: REFERENCE_SOURCE_MAX_BYTES / 2 + 1,
              }),
              expect.objectContaining({
                status: "failed",
                code: "limit",
                size: REFERENCE_SOURCE_MAX_BYTES / 2 + 1,
              }),
            ]),
          },
        },
      },
    });
    expect(result.stdout.length).toBeLessThan(10_000);
    expect(result.exitCode).toBe(1);
  },
);

cliTest.skipIf(process.platform === "win32")(
  "reports oversized packed Git metadata as a resource constraint",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-reference-cli-git-limit-");
    await execFileOutput("git", ["init", "--initial-branch=main"], {
      cwd: root,
    });
    await writeFile(join(root, "main.ts"), "export const value = 1;\n");
    await execFileOutput(
      "git",
      [
        "-c",
        "user.name=REA fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
    await execFileOutput("git", ["pack-refs", "--all", "--prune"], {
      cwd: root,
    });
    await truncate(
      join(root, ".git", "packed-refs"),
      REFERENCE_SOURCE_METADATA_MAX_BYTES + 1,
    );

    const result = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
      cwd: root,
    });

    expect(result.json).toMatchObject({
      error: "Import failed",
      code: "resource_constraint",
      category: "resource_constraint",
      details: {
        diagnostics: { reference_source_code: "limit" },
      },
    });
    expect(result.exitCode).toBe(1);
  },
);

describe("compiled Windows reference-source import", () => {
  for (const scenario of [
    { fullOutput: false, logging: false },
    { fullOutput: true, logging: true },
  ]) {
    cliTest.runIf(process.platform === "win32")(
      `readable root, ${scenario.fullOutput ? "full-output" : "JSON"}, logging ${String(scenario.logging)}`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-reference-host-");
        const source = join(root, "source.js");
        const bytes = "export const answer = 42;\n";
        await writeFile(source, bytes);
        const result = await cli.run({
          arguments: [
            "import-reference-source",
            root,
            "--json",
            ...(scenario.fullOutput ? ["--full-output"] : []),
          ],
          cwd: root,
          environment: {
            USERPROFILE: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
            ...(scenario.logging ? { REA_LOG_LEVEL: "info" } : {}),
          },
        });
        expect(result.json).toEqual(
          scenario.fullOutput
            ? expect.objectContaining({
                ok: false,
                error: expect.objectContaining({
                  code: "capability_unavailable",
                  category: "unsupported_provider",
                  message: expect.stringContaining(
                    "Safe no-follow file opens are unavailable on this host.",
                  ),
                }),
              })
            : unsupportedHostOutput,
        );
        expect.soft(result.exitCode).toBe(1);
        expect(await readFile(source, "utf8")).toBe(bytes);
        if (scenario.logging) {
          expect(JSON.parse(result.stderr.trim())).toMatchObject({
            command: "import-reference-source",
            status: "error",
            level: 50,
            msg: "CLI command failed",
          });
        } else expect(result.stderr).toBe("");
      },
      60_000,
    );
  }
});

describe("compiled reference-source import preflight failures", () => {
  for (const scenario of [
    { rootKind: "missing", fullOutput: false, logging: false },
    { rootKind: "missing", fullOutput: true, logging: true },
    { rootKind: "regular-file", fullOutput: false, logging: true },
    { rootKind: "regular-file", fullOutput: true, logging: false },
  ] as const) {
    cliTest(
      `${scenario.rootKind} root, ${scenario.fullOutput ? "full-output" : "JSON"}, logging ${String(scenario.logging)}`,
      async ({ cli }) => {
        const directory = await createTestTempDirectory(
          "rea-reference-cli-status-",
        );
        // Exercise JSON escaping on POSIX too; Windows paths already need it.
        const root = join(
          directory,
          process.platform === "win32" ? "input" : "input\\escaped",
        );
        if (scenario.rootKind === "regular-file")
          await writeFile(root, "inert input\n");
        const result = await cli.run({
          arguments: [
            "import-reference-source",
            root,
            "--json",
            ...(scenario.fullOutput ? ["--full-output"] : []),
          ],
          cwd: directory,
          environment: {
            HOME: directory,
            USERPROFILE: directory,
            XDG_CONFIG_HOME: directory,
            XDG_CACHE_HOME: directory,
            ...(scenario.logging ? { REA_LOG_LEVEL: "info" } : {}),
          },
        });
        const rootReason =
          scenario.rootKind === "missing"
            ? "Reference source root could not be resolved"
            : "Reference source root is not a directory";
        const invalidRootOutput = {
          category: "invalid_input",
          message: expect.stringContaining(rootReason),
        };
        if (scenario.fullOutput) {
          expect(result.json).toMatchObject({
            ok: false,
            error: invalidRootOutput,
          });
        } else {
          expect(result.json).toMatchObject({
            ...invalidRootOutput,
            error: "Import failed",
          });
        }
        const projection = scenario.fullOutput
          ? (result.json as { error: unknown }).error
          : result.json;
        expect(
          (scenario.fullOutput
            ? analysisErrorProjectionSchema
            : analysisCliErrorEnvelopeSchema
          ).safeParse(projection).success,
        ).toBe(true);
        const messagePath = scenario.fullOutput ? "error.message" : "message";
        expect(result.json).toHaveProperty(
          messagePath,
          expect.stringContaining(
            "Check that the path exists, is readable, and points to a directory.",
          ),
        );
        expect(result.json).toHaveProperty(
          messagePath,
          expect.stringContaining(root),
        );
        expect.soft(result.exitCode).toBe(1);
        if (scenario.logging) {
          const records: unknown[] = result.stderr
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as unknown);
          expect(records).toEqual([
            expect.objectContaining({
              command: "import-reference-source",
              status: "error",
              level: 50,
              msg: "CLI command failed",
            }),
          ]);
        } else {
          expect(result.stderr).toBe("");
        }
      },
    );
  }

  cliTest.skipIf(permissionChecksUnavailable)(
    "classifies a blocked parent directory as an execution failure",
    async ({ cli }) => {
      const directory = await createTestTempDirectory(
        "rea-reference-cli-blocked-root-",
      );
      const parent = join(directory, "blocked-parent");
      const root = join(parent, "input");
      await mkdir(root, { recursive: true });
      await chmod(parent, 0);
      try {
        const result = await cli.run({
          arguments: ["import-reference-source", root, "--json"],
          cwd: directory,
          environment: {
            HOME: directory,
            USERPROFILE: directory,
            XDG_CONFIG_HOME: directory,
            XDG_CACHE_HOME: directory,
          },
        });
        expect(result.json).toMatchObject({
          error: "Import failed",
          category: "execution_failure",
          message: expect.stringContaining("EACCES: permission denied"),
        });
        expect(result.json).toHaveProperty(
          "message",
          expect.stringContaining(root),
        );
        expect(result.json).toHaveProperty(
          "message",
          expect.stringContaining("Check directory permissions and try again."),
        );
        expect(result.exitCode).toBe(1);
      } finally {
        await chmod(parent, 0o700);
      }
    },
  );
});
