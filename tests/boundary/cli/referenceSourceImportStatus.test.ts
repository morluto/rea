import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const invalidRootOutput = {
  error: "Import failed",
  category: "invalid_input",
  message:
    "Reference source directory could not be opened. Check that the path exists, is readable, and points to a directory.",
};

const unsupportedHostOutput = {
  error: "Import failed",
  category: "unsupported_host",
  message:
    "Safe no-follow file opens are unavailable on this host. Import the source tree with REA on Linux (including WSL) or macOS.",
};

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
                ok: true,
                data: unsupportedHostOutput,
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
        const root = join(directory, "input");
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
        if (scenario.fullOutput) {
          // Incur's legacy wrapper remains unchanged; operation status is
          // conveyed by the exit code and command log, not this `ok` field.
          expect(result.json).toMatchObject({
            ok: true,
            data: invalidRootOutput,
          });
        } else {
          expect(result.json).toEqual(invalidRootOutput);
        }
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
});
