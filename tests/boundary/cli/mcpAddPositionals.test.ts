import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const serve = async (
  cli: ReturnType<typeof createCli>,
  arguments_: readonly string[],
): Promise<{ stdout: string; exitCode: number }> => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...arguments_, "--json"], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    exit: (code) => {
      exitCode = code;
    },
  });
  return { stdout, exitCode };
};

const expectMissing = async (path: string): Promise<void> => {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
};

it("rejects surplus positional arguments to built-in MCP registration before writing configuration", async () => {
  const root = await createTestTempDirectory("rea-mcp-add-positionals-");
  const invalidHome = join(root, "invalid-home");
  const validHome = join(root, "valid-home");
  await mkdir(invalidHome);
  await mkdir(validHome);

  const originalHome = process.env.HOME;
  try {
    process.env.HOME = invalidHome;
    for (const helpValue of ["--help", "-h"]) {
      const invalid = await serve(createCli({}), [
        "mcp",
        "add",
        "extra",
        "--filter-output",
        helpValue,
        "--agent",
        "amp",
        "--command",
        "node --version",
      ]);
      expect(invalid.exitCode).toBe(1);
      expect(JSON.parse(invalid.stdout)).toEqual({
        code: "UNKNOWN",
        message:
          "Unexpected positional arguments: \"extra\". Use 'rea mcp add --help' for the declared argument shape.",
      });
      await expectMissing(join(invalidHome, ".config", "amp", "settings.json"));
    }

    const invalid = await serve(createCli({}), [
      "mcp",
      "add",
      "extra",
      "--agent",
      "amp",
      "--command",
      "node --version",
    ]);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toEqual({
      code: "UNKNOWN",
      message:
        "Unexpected positional arguments: \"extra\". Use 'rea mcp add --help' for the declared argument shape.",
    });
    await expectMissing(join(invalidHome, ".config", "amp", "settings.json"));

    process.env.HOME = validHome;
    const valid = await serve(createCli({}), [
      "mcp",
      "add",
      "--agent",
      "amp",
      "--command",
      "node --version",
    ]);
    expect(valid.exitCode).toBe(0);
    expect(valid.stdout).toContain("Registered rea as MCP server");
    const configuration = JSON.parse(
      await readFile(
        join(validHome, ".config", "amp", "settings.json"),
        "utf8",
      ),
    ) as { "amp.mcpServers"?: Record<string, unknown> };
    expect(configuration["amp.mcpServers"]?.rea).toMatchObject({
      command: "node",
      args: ["--version"],
    });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
