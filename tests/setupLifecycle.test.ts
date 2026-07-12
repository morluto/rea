import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
      expect.objectContaining({ name: "cache", status: "retained" }),
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
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "failed",
    );
    expect(await readFile(config, "utf8")).toBe("not-json");
  });
});
