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

for (const source of ["target", "inherited"] as const) {
  cliTest(
    `mcp add refuses an invalid OpenCode environment from the ${source} layer before writing`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-mcp-opencode-admission-");
      const lowerDirectory = join(home, ".config", "opencode");
      const inherited = join(lowerDirectory, "opencode.json");
      const target = join(home, "opencode.json");
      const invalid = JSON.stringify({
        mcp: { rea: { environment: { EXAMPLE_SETTING: 17 } } },
      });
      const original = JSON.stringify({
        mcp: {
          rea: {
            type: "local",
            command: ["original"],
            ...(source === "target"
              ? { environment: { EXAMPLE_SETTING: 17 } }
              : {}),
          },
        },
      });
      await writeFile(target, original);
      if (source === "inherited") {
        await mkdir(lowerDirectory, { recursive: true });
        await writeFile(inherited, invalid);
      }
      const environment = await registrationEnvironment(home, {
        OPENCODE_CONFIG: target,
        OPENCODE_CONFIG_DIR: "",
      });
      const result = await cli.run({
        arguments: [
          "mcp",
          "add",
          "--agent",
          "opencode",
          "--command",
          "replacement",
          "--json",
        ],
        cwd: home,
        environment,
      });
      expect(result.exitCode, result.stderr).toBe(1);
      const report = mcpRegistrationReportSchema.parse(result.json);
      expect(report.clients).toEqual([
        expect.objectContaining({
          config_path: target,
          status: "failed",
          error: expect.objectContaining({
            reason: expect.stringContaining(
              `Configuration ${source === "inherited" ? inherited : target} has an invalid REA server environment: environment.EXAMPLE_SETTING`,
            ),
          }),
        }),
      ]);
      expect(await readFile(target, "utf8")).toBe(original);
      await expect(access(`${target}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
}
