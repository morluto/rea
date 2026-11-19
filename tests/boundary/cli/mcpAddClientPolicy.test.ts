import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { mcpRegistrationReportSchema } from "../../../src/contracts/mcpRegistration.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

// `rea mcp add` registers Gemini CLI through the same client-table row as
// setup, so Gemini's settings policy governs both writers.
cliTest(
  "mcp add refuses a Gemini registration that system settings exclude",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-mcp-gemini-policy-");
    const system = join(home, "system", "settings.json");
    await mkdir(join(home, "system"), { recursive: true });
    await writeFile(system, '{"mcp":{"excluded":["rea"]}}\n');
    const user = join(home, ".gemini", "settings.json");
    await mkdir(join(home, ".gemini"), { recursive: true });
    const original = '{"theme":"dark"}\n';
    await writeFile(user, original);
    const environment = await registrationEnvironment(home, {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: system,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, "system", "defaults.json"),
      GEMINI_CLI_TRUSTED_FOLDERS_PATH: join(home, "trusted.json"),
    });
    const result = await cli.run({
      arguments: ["mcp", "add", "--agent", "gemini", "--json"],
      cwd: home,
      environment,
    });
    expect(result.exitCode, result.stderr).toBe(1);
    const report = mcpRegistrationReportSchema.parse(result.json);
    expect(report.clients).toEqual([
      expect.objectContaining({
        client: "gemini-cli",
        config_path: user,
        status: "failed",
        error: expect.objectContaining({
          reason: expect.stringContaining("Gemini mcp.excluded blocks rea"),
        }),
      }),
    ]);
    expect(await readFile(user, "utf8")).toBe(original);
    await expect(access(`${user}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "mcp add refuses a malformed OpenCode environment before writing settings",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-mcp-opencode-environment-");
    const configDirectory = join(home, ".config", "opencode");
    await mkdir(configDirectory, { recursive: true });
    const path = join(configDirectory, "opencode.json");
    const original =
      '{"mcp":{"rea":{"type":"local","command":["rea","mcp"],"environment":{"EXAMPLE_SETTING":17}}}}\n';
    await writeFile(path, original);
    const result = await cli.run({
      arguments: [
        "mcp",
        "add",
        "--agent",
        "opencode",
        "--command",
        "/replacement mcp",
        "--json",
      ],
      cwd: home,
      environment: await registrationEnvironment(home),
    });
    expect(result.exitCode, result.stderr).toBe(1);
    const report = mcpRegistrationReportSchema.parse(result.json);
    expect(report.clients).toEqual([
      expect.objectContaining({
        client: "opencode",
        config_path: path,
        status: "failed",
        error: expect.objectContaining({
          reason: expect.stringContaining("environment.EXAMPLE_SETTING"),
        }),
      }),
    ]);
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(access(`${path}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
