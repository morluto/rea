import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32")(
  "configures, diagnoses and uninstalls an owned symlink to regular configuration",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-client-config-regular-");
    const directory = join(home, ".codex");
    await mkdir(directory);
    const configPath = join(directory, "config.toml");
    const target = join(home, "managed.toml");
    const original =
      '# Keep this setting.\nmodel = "test"\n[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents@0.1.0", "mcp"]\nstartup_timeout_sec = 30\n';
    await writeFile(target, original);
    await symlink(target, configPath);
    const environment = {
      HOME: home,
      CODEX_HOME: directory,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
    };
    const configured = await cli.run({
      arguments: [
        "setup",
        "--client",
        "codex",
        "--skill=false",
        "--yes",
        "--json",
      ],
      environment,
      timeoutMs: 5_000,
    });
    expect(configured.exitCode).toBe(0);
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    const diagnosed = await cli.run({
      arguments: ["doctor", "--client", "codex", "--skill=false", "--json"],
      environment,
      timeoutMs: 5_000,
    });
    expect(diagnosed.exitCode).toBe(0);
    expect(diagnosed.json).toMatchObject({ healthy: true });
    const removed = await cli.run({
      arguments: ["uninstall", "--json"],
      environment,
      timeoutMs: 5_000,
    });
    expect(removed.exitCode).toBe(0);
    expect(removed.json).toMatchObject({ status: "complete" });
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe(
      '# Keep this setting.\nmodel = "test"\n',
    );
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
  },
);

for (const command of ["doctor", "setup", "uninstall"] as const)
  cliTest.skipIf(process.platform === "win32")(
    `${command} rejects a writer-free client configuration FIFO`,
    async ({ cli, processes }) => {
      const home = await createTestTempDirectory("rea-client-config-fifo-");
      const directory = join(home, ".codex");
      await mkdir(directory);
      const configPath = join(directory, "config.toml");
      const fifo = join(home, "fifo");
      const created = await processes.run("mkfifo", [fifo], {
        timeoutMs: 5_000,
      });
      expect(created.exitCode).toBe(0);
      if (command === "doctor") await symlink(fifo, configPath);
      else {
        const direct = await processes.run("mkfifo", [configPath], {
          timeoutMs: 5_000,
        });
        expect(direct.exitCode).toBe(0);
      }
      const result = await cli.run({
        arguments: [
          command,
          ...(command === "uninstall"
            ? []
            : ["--client", "codex", "--skill=false"]),
          ...(command === "setup" ? ["--dry-run"] : []),
          "--json",
        ],
        environment: {
          HOME: home,
          CODEX_HOME: directory,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
        },
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(
        command === "doctor"
          ? { healthy: false }
          : { status: command === "setup" ? "needs_human" : "failed" },
      );
      expect(JSON.stringify(result.json)).toContain("regular file");
      expect((await lstat(fifo)).isFIFO()).toBe(true);
      expect((await lstat(configPath)).isSymbolicLink()).toBe(
        command === "doctor",
      );
      await expect(lstat(`${configPath}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
