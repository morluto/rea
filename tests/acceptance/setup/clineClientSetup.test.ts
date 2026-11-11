import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  cliTest,
  type CliResult,
  type TestCli,
} from "../../support/cli/cliFixture.js";

cliTest(
  "registers Cline at its documented path and preserves peers and backups",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-cline-home-");
    const config = join(
      home,
      ".cline",
      "data",
      "settings",
      "cline_mcp_settings.json",
    );
    const original = JSON.stringify({
      mcpServers: { peer: { command: "peer" } },
    });
    await mkdir(join(home, ".cline", "data", "settings"), { recursive: true });
    await writeFile(config, original);
    const run = () =>
      cli.run({
        arguments: [
          "setup",
          "--client",
          "cline",
          "--skill=false",
          "--yes",
          "--json",
        ],
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          HOPPER_LAUNCHER_PATH: join(home, "missing-hopper"),
          GHIDRA_INSTALL_DIR: join(home, "missing-ghidra"),
          JAVA_HOME: join(home, "missing-java"),
        },
      });
    const first = await run();
    expect(first.exitCode, first.stdout).toBe(0);
    const configured = await readFile(config, "utf8");
    expect(JSON.parse(configured)).toMatchObject({
      mcpServers: {
        peer: { command: "peer" },
        rea: { args: expect.arrayContaining(["mcp"]) },
      },
    });
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
    const second = await run();
    expect(second.exitCode, second.stdout).toBe(0);
    expect(await readFile(config, "utf8")).toBe(configured);
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
  },
);

cliTest(
  "honors CLINE_MCP_SETTINGS_PATH and leaves the default file absent",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-cline-override-");
    const override = join(home, "custom", "settings.json");
    const defaultPath = join(
      home,
      ".cline",
      "data",
      "settings",
      "cline_mcp_settings.json",
    );
    const result = await cli.run({
      arguments: [
        "setup",
        "--client",
        "cline",
        "--skill=false",
        "--yes",
        "--json",
      ],
      cwd: home,
      environment: {
        HOME: home,
        USERPROFILE: home,
        CLINE_MCP_SETTINGS_PATH: override,
        HOPPER_LAUNCHER_PATH: join(home, "missing-hopper"),
        GHIDRA_INSTALL_DIR: join(home, "missing-ghidra"),
        JAVA_HOME: join(home, "missing-java"),
      },
    });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(await readFile(override, "utf8"))).toMatchObject({
      mcpServers: { rea: { args: expect.arrayContaining(["mcp"]) } },
    });
    await expect(access(defaultPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest(
  "resolves the Cline skill client to the shared skills directory",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-cline-skill-");
    const result = await cli.run({
      arguments: [
        "setup",
        "--skill-client",
        "cline",
        "--skill",
        "--dry-run",
        "--json",
      ],
      cwd: home,
      environment: {
        HOME: home,
        USERPROFILE: home,
        HOPPER_LAUNCHER_PATH: join(home, "missing-hopper"),
        GHIDRA_INSTALL_DIR: join(home, "missing-ghidra"),
        JAVA_HOME: join(home, "missing-java"),
      },
    });
    expect(result.exitCode, result.stdout).toBe(0);
    const plan = result.json as {
      status: string;
      plannedActions: { id: string; target: string }[];
    };
    const skill = plan.plannedActions.filter(
      ({ id }) => id === "install_skill",
    );
    expect(skill).toHaveLength(1);
    expect(skill[0]!.target).toBe(
      join(home, ".agents", "skills", "reverse-engineer-anything"),
    );
  },
);

const clineEnvironment = (home: string) => ({
  HOME: home,
  USERPROFILE: home,
  HOPPER_LAUNCHER_PATH: join(home, "missing-hopper"),
  GHIDRA_INSTALL_DIR: join(home, "missing-ghidra"),
  JAVA_HOME: join(home, "missing-java"),
});

const setupCline = (cli: TestCli, home: string): Promise<CliResult> =>
  cli.run({
    arguments: [
      "setup",
      "--client",
      "cline",
      "--skill=false",
      "--yes",
      "--json",
    ],
    cwd: home,
    environment: clineEnvironment(home),
  });

cliTest(
  "reports the Cline registration as aligned and REA-owned",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-cline-doctor-");
    expect((await setupCline(cli, home)).exitCode).toBe(0);
    const doctor = await cli.run({
      arguments: ["doctor", "--client", "cline", "--json"],
      cwd: home,
      environment: clineEnvironment(home),
    });
    const report = doctor.json as {
      identity: {
        registrations: {
          client: string;
          state: string;
          command_identity: string;
        }[];
      };
    };
    const registration = report.identity.registrations.find(
      ({ client }) => client === "cline",
    );
    expect(registration?.state).toBe("aligned");
    expect(registration?.command_identity).toBe("owned");
  },
);

cliTest(
  "refuses a foreign rea registration in the Cline file",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-cline-foreign-");
    const directory = join(home, ".cline", "data", "settings");
    const config = join(directory, "cline_mcp_settings.json");
    const foreign = JSON.stringify({
      mcpServers: { rea: { command: "custom", args: ["keep"] } },
    });
    await mkdir(directory, { recursive: true });
    await writeFile(config, foreign);
    const result = await setupCline(cli, home);
    expect(result.exitCode).toBe(1);
    const plan = result.json as { status: string; remediation: string | null };
    expect(plan.status).toBe("needs_human");
    expect(plan.remediation).toContain("foreign ownership");
    expect(await readFile(config, "utf8")).toBe(foreign);
  },
);

cliTest(
  "uninstall removes only the REA entry from the Cline file",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-cline-uninstall-");
    const directory = join(home, ".cline", "data", "settings");
    const config = join(directory, "cline_mcp_settings.json");
    await mkdir(directory, { recursive: true });
    await writeFile(
      config,
      JSON.stringify({ mcpServers: { peer: { command: "peer" } } }),
    );
    expect((await setupCline(cli, home)).exitCode).toBe(0);
    const removal = await cli.run({
      arguments: ["uninstall", "--json"],
      cwd: home,
      environment: clineEnvironment(home),
    });
    expect(removal.exitCode, removal.stdout).toBe(0);
    const report = removal.json as {
      items: { name: string; status: string }[];
    };
    expect(report.items.find(({ name }) => name === "cline")?.status).toBe(
      "removed",
    );
    const remaining = JSON.parse(await readFile(config, "utf8"));
    expect(remaining.mcpServers).toEqual({ peer: { command: "peer" } });
  },
);

cliTest(
  "refuses a malformed Cline configuration without rewriting it",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-cline-malformed-");
    const directory = join(home, ".cline", "data", "settings");
    const config = join(directory, "cline_mcp_settings.json");
    const malformed = '{"mcpServers": {';
    await mkdir(directory, { recursive: true });
    await writeFile(config, malformed);
    const result = await setupCline(cli, home);
    expect(result.exitCode).toBe(1);
    expect(await readFile(config, "utf8")).toBe(malformed);
  },
);

cliTest(
  "refreshes an owned nested Cline transport without losing its settings",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-cline-nested-");
    const config = join(
      home,
      ".cline",
      "data",
      "settings",
      "cline_mcp_settings.json",
    );
    expect((await setupCline(cli, home)).exitCode).toBe(0);
    const configured = JSON.parse(await readFile(config, "utf8"));
    const original = configured.mcpServers.rea;
    const transport = {
      type: "stdio",
      command: original.command,
      args: original.args,
      env: { ...original.env, CLINE_NESTED_VALUE: "caller selected" },
      cwd: home,
      metadata: { selected: "nested transport" },
    };
    const nested = {
      ...configured,
      mcpServers: {
        ...configured.mcpServers,
        peer: { command: "recorded-peer" },
        rea: {
          transport,
          env: { SHADOWED_OUTER_VALUE: "retained but not selected" },
          metadata: { selected: "outer registration" },
        },
      },
    };
    await writeFile(config, JSON.stringify(nested));
    const refreshed = await setupCline(cli, home);
    expect(refreshed.exitCode, refreshed.stdout).toBe(0);
    const after = await readFile(config, "utf8");
    expect(JSON.parse(after)).toEqual(nested);
    const doctor = await cli.run({
      arguments: ["doctor", "--client", "cline", "--json"],
      cwd: home,
      environment: clineEnvironment(home),
    });
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: [
          expect.objectContaining({
            client: "cline",
            state: "aligned",
            command_identity: "owned",
          }),
        ],
      },
    });
    expect((await setupCline(cli, home)).exitCode).toBe(0);
    expect(await readFile(config, "utf8")).toBe(after);
    const removal = await cli.run({
      arguments: ["uninstall", "--json"],
      cwd: home,
      environment: clineEnvironment(home),
    });
    expect(removal.exitCode, removal.stdout).toBe(0);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      ...nested,
      mcpServers: { peer: { command: "recorded-peer" } },
    });
  },
);
