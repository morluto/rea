import {
  access,
  mkdir,
  readFile,
  readlink,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { mcpRegistrationReportSchema } from "../../../src/contracts/mcpRegistration.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
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

cliTest(
  "project OpenCode registration verifies the launcher in native load order before publishing",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-mcp-opencode-project-policy-",
    );
    const project = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(join(project, ".opencode"));
    const environment = await registrationEnvironment(home, {});
    const selected = join(project, "opencode.jsonc");
    const higher = join(project, ".opencode", "opencode.json");
    const local = (command: string) =>
      JSON.stringify({
        mcp: { servers: { rea: { type: "local", command: [command, "mcp"] } } },
      });
    const original = local("previous-direct-launcher");
    const overriding = local("nested-launcher");
    await writeFile(selected, original);
    await writeFile(higher, overriding);
    const blocked = await addOpenCodeProject(cli, project, environment);
    expect(blocked.exitCode).toBe(1);
    expect(mcpRegistrationReportSchema.parse(blocked.json)).toMatchObject({
      ok: false,
      clients: [
        {
          config_path: selected,
          scope: "project",
          status: "failed",
          error: { reason: expect.stringContaining(higher) },
        },
      ],
    });
    expect(await readFile(selected, "utf8")).toBe(original);
    expect(await readFile(higher, "utf8")).toBe(overriding);
    for (const path of [selected, higher])
      await expect(access(`${path}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });

    await unlink(higher);
    expect((await addOpenCodeProject(cli, project, environment)).exitCode).toBe(
      0,
    );
    expect(JSON.parse(await readFile(selected, "utf8"))).toMatchObject({
      mcp: { servers: { rea: { command: ["rea", "mcp"] } } },
    });
    expect(await readFile(`${selected}.rea.backup`, "utf8")).toBe(original);

    const fresh = join(root, "new-project");
    await mkdir(fresh);
    expect((await addOpenCodeProject(cli, fresh, environment)).exitCode).toBe(
      0,
    );
    expect(
      JSON.parse(await readFile(join(fresh, "opencode.jsonc"), "utf8")),
    ).toMatchObject({
      mcp: { rea: { command: ["rea", "mcp"] } },
    });
  },
);

cliTest.skipIf(process.platform === "win32")(
  "project OpenCode registration cannot create a user settings file through an alias",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mcp-opencode-user-alias-");
    const project = join(root, "project");
    const parentAlias = join(root, "project-alias");
    const fileAlias = join(root, "user-override.jsonc");
    await mkdir(project);
    const selected = join(project, "opencode.jsonc");
    await symlink(project, parentAlias);
    await symlink(selected, fileAlias);
    for (const userPath of [join(parentAlias, "opencode.jsonc"), fileAlias]) {
      const result = await addOpenCodeProject(
        cli,
        project,
        await registrationEnvironment(join(root, "home"), {
          OPENCODE_CONFIG: userPath,
        }),
      );
      expect(result.exitCode, userPath).toBe(1);
      for (const path of [selected, userPath, `${selected}.rea.backup`])
        await expect(access(path), path).rejects.toMatchObject({
          code: "ENOENT",
        });
      expect(mcpRegistrationReportSchema.parse(result.json)).toMatchObject({
        ok: false,
        clients: [
          {
            config_path: selected,
            scope: "project",
            status: "failed",
            error: { reason: expect.stringContaining(userPath) },
          },
        ],
      });
    }
    expect(await readlink(fileAlias)).toBe(selected);
  },
);

cliTest.skipIf(process.platform === "win32")(
  "project OpenCode registration replays a proposed edit through a higher alias of the same file",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-mcp-opencode-project-alias-",
    );
    const project = join(root, "project");
    const selected = join(project, "opencode.jsonc");
    const higher = join(project, ".opencode", "opencode.json");
    const original =
      '{"mcp":{"servers":{"rea":{"type":"local","command":["previous-direct-launcher","mcp"]}}}}';
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(dirname(higher));
    await writeFile(selected, original);
    await symlink(selected, higher);
    const result = await addOpenCodeProject(
      cli,
      project,
      await registrationEnvironment(join(root, "home"), {}),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(mcpRegistrationReportSchema.parse(result.json)).toMatchObject({
      ok: true,
      clients: [
        { config_path: selected, scope: "project", status: "configured" },
      ],
    });
    expect(await readlink(higher)).toBe(selected);
    expect(JSON.parse(await readFile(higher, "utf8"))).toMatchObject({
      mcp: { servers: { rea: { command: ["rea", "mcp"] } } },
    });
    expect(await readFile(`${selected}.rea.backup`, "utf8")).toBe(original);
  },
);

const addOpenCodeProject = (
  cli: TestCli,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) =>
  cli.run({
    arguments: [
      "mcp",
      "add",
      "--no-global",
      "--agent",
      "opencode",
      "--command",
      "rea mcp",
      "--json",
    ],
    cwd,
    environment,
  });
