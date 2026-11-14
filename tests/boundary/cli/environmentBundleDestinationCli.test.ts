import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { writeEnvironmentServeFiles } from "../../fixtures/environmentServe.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["environment-export", "environment-build"] as const)(
  "%s attributes non-directory parents to the selected destination",
  async (command, { cli }) => {
    const root = await createTestTempDirectory("rea-bundle-parent-");
    const files = await writeEnvironmentServeFiles(root);
    const occupied = join(root, "parentfile");
    await writeFile(occupied, "keep\n");
    const before = await stat(occupied);
    const entries = await readdir(root);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected stdio MCP session");
    for (const directory of [
      join(occupied, "bundle"),
      join(occupied, "missing", "bundle"),
    ]) {
      const arguments_ =
        command === "environment-export"
          ? [command, files.manifestPath, "--evidence", files.capturePath]
          : [command, files.capturePath];
      const result = await cli.run({
        arguments: [...arguments_, directory, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: {
          issues: [{ path: ["directory"], reason: "invalid_value" }],
        },
        recovery: {
          kind: "inspect_input_contract",
          operation: "environment-export",
        },
      });
      const mcp = await call("export_environment_bundle", {
        source: { kind: "evidence-file", path: files.capturePath },
        output_directory: directory,
      });
      expect(mcp.isError).toBe(true);
      expect(parseMcpToolError(mcp).error).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: {
          issues: [{ path: ["output_directory"], reason: "invalid_value" }],
        },
        recovery: {
          kind: "inspect_input_contract",
          operation: "export_environment_bundle",
        },
      });
      expect(await readFile(occupied, "utf8")).toBe("keep\n");
      const after = await stat(occupied);
      expect({ dev: after.dev, ino: after.ino }).toEqual({
        dev: before.dev,
        ino: before.ino,
      });
      expect(await readdir(root)).toEqual(entries);
    }
  },
);

cliTest.for(["environment-export", "environment-build"] as const)(
  "%s still creates missing parents and accepts an empty destination",
  async (command, { cli }) => {
    const root = await createTestTempDirectory("rea-bundle-parent-control-");
    const files = await writeEnvironmentServeFiles(root);
    const empty = join(root, "empty");
    await mkdir(empty);
    for (const directory of [
      join(root, "missing", "nested", "bundle"),
      empty,
    ]) {
      const arguments_ =
        command === "environment-export"
          ? [command, files.manifestPath, "--evidence", files.capturePath]
          : [command, files.capturePath];
      const result = await cli.run({
        arguments: [...arguments_, directory, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.json).toMatchObject({
        status: command === "environment-export" ? "exported" : "built",
      });
      expect(
        (
          await readFile(join(directory, "envs/grafana-example/evidence.json"))
        ).equals(await readFile(files.capturePath)),
      ).toBe(true);
    }
  },
);
