import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const expectMissing = async (path: string): Promise<void> => {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
};

cliTest(
  "rejects surplus positional arguments to built-in MCP registration before writing configuration",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mcp-add-positionals-");
    const invalidHome = join(root, "invalid-home");
    const validHome = join(root, "valid-home");
    await mkdir(invalidHome);
    await mkdir(validHome);

    const settingsPath = (home: string): string =>
      join(home, ".config", "amp", "settings.json");
    const run = (home: string, arguments_: readonly string[]) =>
      cli.run({
        arguments: [...arguments_],
        cwd: root,
        environment: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_STATE_HOME: join(home, ".local", "state"),
        },
      });
    const registration = [
      "mcp",
      "add",
      "extra",
      "--agent",
      "amp",
      "--command",
      "node --version",
    ];
    const invalidCases = [
      { name: "JSON", flags: ["--json"] },
      { name: "full-output JSON", flags: ["--json", "--full-output"] },
      {
        name: "full-output JSON Lines",
        flags: ["--format", "jsonl", "--full-output"],
      },
      {
        name: "CSV",
        flags: [
          "--format",
          "csv",
          "--filter-output",
          "rows",
          "--columns",
          "code",
        ],
      },
      {
        name: "TSV",
        flags: [
          "--format",
          "tsv",
          "--filter-output",
          "rows",
          "--columns",
          "code",
        ],
      },
      {
        name: "help-shaped filter value",
        flags: ["--filter-output", "--help", "--json"],
      },
      {
        name: "short-help-shaped filter value",
        flags: ["--filter-output", "-h", "--json"],
      },
    ];

    for (const scenario of invalidCases) {
      const result = await run(invalidHome, [
        ...registration,
        ...scenario.flags,
      ]);
      expect(result.exitCode, scenario.name).toBe(1);
      expect(result.stderr, scenario.name).toBe("");
      if (scenario.name === "full-output JSON") {
        expect(result.json).toMatchObject({
          ok: false,
          error: {
            code: "UNKNOWN",
            message: expect.stringContaining("extra"),
          },
          meta: {
            command: "mcp add",
            duration: expect.stringMatching(/^\d+ms$/),
          },
        });
      } else if (scenario.name === "full-output JSON Lines") {
        expect(result.json).toMatchObject({
          $rea: expect.any(String),
          type: "error",
          ok: false,
          result: {
            ok: false,
            error: {
              code: "UNKNOWN",
              message: expect.stringContaining("extra"),
            },
            meta: {
              command: "mcp add",
              duration: expect.stringMatching(/^\d+ms$/),
            },
          },
        });
      } else {
        expect(result.json).toMatchObject({
          code: "UNKNOWN",
          message: expect.stringContaining("extra"),
        });
      }
      expect(JSON.stringify(result.json), scenario.name).not.toContain(
        "selected output path does not contain a row array",
      );
      await expectMissing(settingsPath(invalidHome));
    }

    const valid = await run(validHome, [
      "mcp",
      "add",
      "--agent",
      "amp",
      "--command",
      "node --version",
    ]);
    expect(valid.exitCode, valid.stderr).toBe(0);
    expect(valid.stdout).toContain("Registered rea as MCP server");
    const configuration = JSON.parse(
      await readFile(settingsPath(validHome), "utf8"),
    ) as { "amp.mcpServers"?: Record<string, unknown> };
    expect(configuration["amp.mcpServers"]?.rea).toMatchObject({
      command: "node",
      args: ["--version"],
    });
  },
);
