import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { mcpRegistrationReportSchema } from "../../../src/contracts/mcpRegistration.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

cliTest(
  "mcp add reports each selected client's own refusal without writing settings or backups",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-mcp-client-policy-");
    const system = join(home, "system", "settings.json");
    const clients = [
      {
        client: "gemini-cli",
        path: join(home, ".gemini", "settings.json"),
        original: '{"theme":"dark"}\n',
        reason: "Gemini mcp.excluded blocks rea",
      },
      {
        client: "opencode",
        path: join(home, ".config", "opencode", "opencode.json"),
        original:
          '{"mcp":{"rea":{"type":"local","command":["rea","mcp"],"environment":{"EXAMPLE_SETTING":17}}}}\n',
        reason: "environment.EXAMPLE_SETTING",
      },
    ];
    await mkdir(dirname(system), { recursive: true });
    await writeFile(system, '{"mcp":{"excluded":["rea"]}}\n');
    for (const { path, original } of clients) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, original);
    }
    const environment = await registrationEnvironment(home, {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: system,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, "system", "defaults.json"),
      GEMINI_CLI_TRUSTED_FOLDERS_PATH: join(home, "trusted.json"),
    });
    const result = await cli.run({
      arguments: [
        "mcp",
        "add",
        "--agent",
        "gemini",
        "--agent",
        "opencode",
        "--command",
        "/replacement mcp",
        "--json",
      ],
      cwd: home,
      environment,
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(mcpRegistrationReportSchema.parse(result.json)).toMatchObject({
      ok: false,
      clients: clients.map(({ client, path, reason }) => ({
        client,
        config_path: path,
        status: "failed",
        error: { reason: expect.stringContaining(reason) },
      })),
    });

    for (const { path, original } of clients) {
      expect(await readFile(path, "utf8"), path).toBe(original);
      await expect(access(`${path}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  },
);
