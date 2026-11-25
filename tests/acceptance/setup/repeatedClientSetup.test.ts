import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "deduplicates explicit clients, joins detected clients and applies setup once",
  async ({ cli }) => {
    const home = await createTestTempDirectory(
      "rea-explicit-detected-clients-",
    );
    await mkdir(join(home, ".codex"));
    await mkdir(join(home, ".grokbot"));
    const run = (selection: readonly string[], mode: string) =>
      cli.run({
        arguments: ["setup", ...selection, "--skill=false", "--json", mode],
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          TMPDIR: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_STATE_HOME: join(home, ".local", "state"),
        },
      });
    const configurations = [
      join(home, ".cursor", "mcp.json"),
      join(home, ".codex", "config.toml"),
    ];
    const combined = [
      "--client",
      "cursor",
      "--client",
      "cursor",
      "--all-detected",
    ];
    for (const [selection, expected] of [
      [["--client", "cursor"], ["cursor"]],
      [
        ["--client", "cursor", "--client", "codex", "--client", "cursor"],
        ["cursor", "codex"],
      ],
      [["--all-detected"], ["codex"]],
      [combined, ["cursor", "codex"]],
    ] as const) {
      const preview = await run(selection, "--dry-run");
      expect(preview.exitCode, preview.stdout).toBe(0);
      expect(preview.json).toMatchObject({
        status: "planned",
        plannedActions: expected.map((id) => ({
          id: `configure_client:${id}`,
        })),
        appliedActions: [],
      });
      for (const path of configurations)
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const applied = await run(combined, "--yes");
    expect(applied.exitCode, applied.stdout).toBe(0);
    expect(applied.json).toMatchObject({
      status: "ready",
      plannedActions: [
        { id: "configure_client:cursor" },
        { id: "configure_client:codex" },
      ],
      appliedActions: ["configured_cursor", "configured_codex"],
      clients: {
        cursor: { status: "configured" },
        codex: { status: "configured" },
      },
      doctor: {
        healthy: true,
        scope: {
          mode: "explicit",
          clients: ["codex", "cursor"],
          providers: [],
          skill: false,
        },
      },
    });
    const readConfigurations = () =>
      Promise.all(configurations.map((path) => readFile(path, "utf8")));
    const configured = await readConfigurations();
    for (const contents of configured) expect(contents).toContain("rea");
    const repeated = await run(combined, "--yes");
    expect(repeated.exitCode, repeated.stdout).toBe(0);
    expect(repeated.json).toMatchObject({
      status: "ready",
      plannedActions: [],
      appliedActions: [],
    });
    expect(await readConfigurations()).toEqual(configured);
  },
);

cliTest(
  "uninstall preserves user edits made after an earlier setup",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-current-uninstall-backup-");
    const config = join(home, ".cursor", "mcp.json");
    const original = '{"mcpServers":{"other":{"command":"other-server"}}}\n';
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(config, original);
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: [...arguments_, "--json"],
        cwd: home,
        environment: { HOME: home, USERPROFILE: home, TMPDIR: home },
      });
    const planned = await run([
      "setup",
      "--client",
      "cursor",
      "--skill=false",
      "--dry-run",
    ]);
    expect(planned.exitCode, planned.stderr).toBe(0);
    expect(planned.json).toMatchObject({ status: "planned" });
    expect(await readFile(config, "utf8")).toBe(original);
    const installed = await run([
      "setup",
      "--client",
      "cursor",
      "--skill=false",
      "--yes",
    ]);
    expect(installed.exitCode, installed.stderr).toBe(0);
    expect(installed.json).toMatchObject({ status: "ready" });
    const current = (await readFile(config, "utf8")).replace(
      "other-server",
      "edited-server",
    );
    expect(current).toContain("edited-server");
    await writeFile(config, current);

    const removed = await run(["uninstall"]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.json).toMatchObject({ status: "complete" });
    const recovery = `${config}.rea.backup.${createHash("sha256").update(current).digest("hex")}.recovery`;
    expect(await readFile(recovery, "utf8")).toBe(current);
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      mcpServers: { other: { command: "edited-server" } },
    });
  },
);
