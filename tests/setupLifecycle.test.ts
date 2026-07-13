import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureTomlClient,
  detectClients,
} from "../src/application/Setup.js";
import {
  runUninstall,
  systemUninstallHost,
  type UninstallFileSystem,
} from "../src/application/Uninstall.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("agent lifecycle", () => {
  it("detects every supported client and skips absent clients", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-detect-"));
    roots.push(home);
    for (const marker of [
      ".claude",
      "Library/Application Support/Claude",
      ".codex",
      ".cursor",
      ".gemini",
      ".codeium/windsurf",
      ".devin",
    ])
      await mkdir(join(home, marker), { recursive: true });
    const detected = await detectClients(home);
    expect(detected.map(({ name }) => name)).toEqual([
      "claude_code",
      "claude_desktop",
      "codex",
      "cursor",
      "gemini_cli",
      "windsurf",
      "devin",
    ]);
    expect(
      detected.find(({ name }) => name === "claude_code")?.configPath,
    ).toBe(join(home, ".claude.json"));
    expect(detected.find(({ name }) => name === "devin")?.format).toBe(
      "unsupported",
    );
    const emptyHome = await mkdtemp(join(tmpdir(), "rea-empty-"));
    roots.push(emptyHome);
    expect(await detectClients(emptyHome)).toEqual([]);
  });

  it("preserves unrelated Codex TOML and supports an installed command", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-toml-"));
    roots.push(home);
    const configPath = join(home, ".codex/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      'model = "gpt-5"\n[mcp_servers.other]\ncommand = "other"\n',
    );
    expect(
      await configureTomlClient(
        { name: "codex", configPath, format: "toml" },
        "/Hopper Path",
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain('model = "gpt-5"');
    expect(configured).toContain("[mcp_servers.rea]");
    expect(configured).toContain('command = "rea"');
    expect(
      await configureTomlClient(
        { name: "codex", configPath, format: "toml" },
        "/Hopper Path",
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
  });

  it("uninstalls only owned entries and refuses purge symlinks", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-uninstall-"));
    roots.push(home);
    const cursor = join(home, ".cursor/mcp.json");
    const skill = join(home, ".agents/skills/rea-analysis/SKILL.md");
    await mkdir(dirname(cursor), { recursive: true });
    await mkdir(dirname(skill), { recursive: true });
    await writeFile(
      cursor,
      JSON.stringify({
        mcpServers: {
          rea: { command: "/isolated prefix/bin/rea", args: ["mcp"] },
          other: { command: "other" },
        },
      }),
    );
    await writeFile(skill, "managed");
    await mkdir(join(home, ".rea"), { recursive: true });
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(home, join(home, ".rea/cache")),
    );
    const first = await runUninstall(true, systemUninstallHost(home));
    expect(first.status).toBe("complete");
    expect(JSON.parse(await readFile(cursor, "utf8"))).toEqual({
      mcpServers: { other: { command: "other" } },
    });
    expect(first.items).toContainEqual(
      expect.objectContaining({
        name: "cache",
        status: "retained",
        detail:
          "REA did not remove this item because its managed path is a symbolic link. Verify the link target before removing it manually.",
      }),
    );
    expect((await runUninstall(true, systemUninstallHost(home))).status).toBe(
      "complete",
    );
  });

  it("fails closed on malformed client configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-uninstall-bad-"));
    roots.push(home);
    const config = join(home, ".cursor/mcp.json");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, "not-json");
    const result = await runUninstall(false, systemUninstallHost(home));
    expect(result.status).toBe("failed");
    expect(result.items).toContainEqual(
      expect.objectContaining({
        name: "cursor",
        status: "failed",
        detail:
          "Configuration is not valid JSON and was not changed. Repair it, then rerun uninstall.",
      }),
    );
    expect(await readFile(config, "utf8")).toBe("not-json");
  });

  it.each([
    [
      "read",
      "Configuration could not be read. Check file permissions, then rerun uninstall.",
    ],
    [
      "backup",
      "Configuration could not be backed up, so no change was made. Check file permissions, then rerun uninstall.",
    ],
    [
      "update",
      "Configuration could not be updated. The original was restored and its `.rea.backup` was retained. Repair the configuration or restore the backup, then rerun uninstall.",
    ],
    [
      "restore",
      "Configuration could not be updated or restored. Restore its `.rea.backup` manually, then rerun uninstall.",
    ],
  ] as const)(
    "reports an actionable client %s failure",
    async (failure, detail) => {
      const { home, config } = await uninstallFixture();
      let writes = 0;
      const fileSystem: UninstallFileSystem = {
        ...testFileSystem,
        readText: (path) =>
          failure === "read" && path === config
            ? Promise.reject(new Error("SECRET read failure"))
            : readFile(path, "utf8"),
        copy: (source, destination) =>
          failure === "backup"
            ? Promise.reject(new Error("SECRET backup failure"))
            : copyFile(source, destination),
        writeText: async (path, contents) => {
          writes += 1;
          if ((failure === "update" && writes === 1) || failure === "restore")
            throw new Error("SECRET write failure");
          await writeFile(path, contents);
        },
      };
      const result = await runUninstall(
        false,
        systemUninstallHost(home, fileSystem),
      );
      expect(result.status).toBe("failed");
      expect(result.items).toContainEqual(
        expect.objectContaining({ name: "cursor", status: "failed", detail }),
      );
      expect(JSON.stringify(result)).not.toContain("SECRET");
    },
  );

  it("reports a managed-path removal failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-uninstall-remove-"));
    roots.push(home);
    const skillRoot = join(home, ".agents/skills/rea-analysis");
    await mkdir(skillRoot, { recursive: true });
    const result = await runUninstall(
      false,
      systemUninstallHost(home, {
        ...testFileSystem,
        remove: () => Promise.reject(new Error("SECRET removal failure")),
      }),
    );
    expect(result.items).toContainEqual({
      name: "skill",
      status: "failed",
      detail:
        "This item could not be removed. Check file permissions, then rerun uninstall.",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

const testFileSystem: UninstallFileSystem = {
  readText: (path) => readFile(path, "utf8"),
  copy: (source, destination) => copyFile(source, destination),
  writeText: (path, contents) => writeFile(path, contents),
  stat: (path) => lstat(path),
  remove: (path) => rm(path, { recursive: true }),
};

const uninstallFixture = async (): Promise<{
  readonly home: string;
  readonly config: string;
}> => {
  const home = await mkdtemp(join(tmpdir(), "rea-uninstall-failure-"));
  roots.push(home);
  const config = join(home, ".cursor/mcp.json");
  await mkdir(dirname(config), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { rea: { command: "rea", args: ["mcp"] } } }),
  );
  return { home, config };
};
