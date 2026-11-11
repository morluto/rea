import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

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
