import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";

import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import {
  runUninstall,
  systemUninstallHost,
  type UninstallFileSystem,
} from "../../../src/application/Uninstall.js";

const roots: string[] = [];
beforeEach(() => {
  for (const name of [
    "APPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "COPILOT_HOME",
    "GROK_HOME",
    "OPENCODE_CONFIG",
    "SAND_DATA_ROOT",
    "XDG_CONFIG_HOME",
  ])
    vi.stubEnv(name, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("client configuration filesystem lifecycle", () => {
  it("detects every supported client and skips absent clients", async () => {
    const home = await createTestTempDirectory("rea-detect-");
    roots.push(home);
    for (const client of supportedClients(home))
      if (client.markerPath !== undefined)
        await mkdir(client.markerPath, { recursive: true });
    const detected = await detectClients(home);
    expect(detected.map(({ name }) => name)).toEqual([
      "claude_code",
      "claude_desktop",
      "codex",
      "cursor",
      "gemini_cli",
      "windsurf",
      "devin",
      "opencode",
      "antigravity",
      "copilot_cli",
      "commandcode",
      "vscode",
      "grok_build",
      "grok_bot",
    ]);
    expect(
      detected.find(({ name }) => name === "claude_code")?.configPath,
    ).toBe(join(home, ".claude.json"));
    expect(detected.find(({ name }) => name === "devin")?.format).toBe("json");
    const emptyHome = await createTestTempDirectory("rea-empty-");
    roots.push(emptyHome);
    expect(await detectClients(emptyHome)).toEqual([]);
  });

  it("preserves unrelated Codex TOML and supports an installed command", async () => {
    const home = await createTestTempDirectory("rea-toml-");
    roots.push(home);
    const configPath = join(home, ".codex/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      'model = "gpt-5"\n[mcp_servers.other]\ncommand = "other"\n',
    );
    expect(
      await configureClientConfiguration(
        { name: "codex", configPath, format: "toml" },
        {
          HOPPER_LAUNCHER_PATH: "/Hopper Path",
          GHIDRA_INSTALL_DIR: "/opt/ghidra",
          JAVA_HOME: "/opt/jdk-21",
        },
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain('model = "gpt-5"');
    expect(configured).toContain("[mcp_servers.rea]");
    expect(configured).toContain('command = "rea"');
    expect(configured).toContain("startup_timeout_sec = 30");
    expect(configured).toContain('GHIDRA_INSTALL_DIR = "/opt/ghidra"');
    expect(configured).toContain('JAVA_HOME = "/opt/jdk-21"');
    expect(
      await configureClientConfiguration(
        { name: "codex", configPath, format: "toml" },
        {
          HOPPER_LAUNCHER_PATH: "/Hopper Path",
          GHIDRA_INSTALL_DIR: "/opt/ghidra",
          JAVA_HOME: "/opt/jdk-21",
        },
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
  });

  it("does not rewrite an equivalent Codex registration with reordered environment keys", async () => {
    const home = await createTestTempDirectory("rea-toml-");
    roots.push(home);
    const configPath = join(home, ".codex/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `[mcp_servers.rea]\ncommand = "rea"\nargs = ["mcp"]\nstartup_timeout_sec = 30\n\n[mcp_servers.rea.env]\nJAVA_HOME = "/opt/jdk-21"\nHOPPER_LAUNCHER_PATH = "/Hopper Path"\nGHIDRA_INSTALL_DIR = "/opt/ghidra"\n`,
    );

    const original = await readFile(configPath, "utf8");
    expect(
      await configureClientConfiguration(
        { name: "codex", configPath, format: "toml" },
        {
          HOPPER_LAUNCHER_PATH: "/Hopper Path",
          GHIDRA_INSTALL_DIR: "/opt/ghidra",
          JAVA_HOME: "/opt/jdk-21",
        },
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });

  it("updates a symlink target without replacing the TOML config symlink", async () => {
    const home = await createTestTempDirectory("rea-toml-symlink-");
    roots.push(home);
    const configPath = join(home, ".codex/config.toml");
    const targetPath = join(home, "managed-config.toml");
    const original = 'model = "gpt-5"\n';
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(targetPath, original);
    await symlink(targetPath, configPath);

    expect(
      await configureClientConfiguration(
        { name: "codex", configPath, format: "toml" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(await readFile(targetPath, "utf8")).toContain("[mcp_servers.rea]");
  });

  it("fails before mutation when a TOML config symlink is dangling", async () => {
    const home = await createTestTempDirectory("rea-toml-symlink-");
    roots.push(home);
    const configPath = join(home, ".codex/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await symlink(join(home, "missing-config.toml"), configPath);

    expect(
      await configureClientConfiguration({
        name: "codex",
        configPath,
        format: "toml",
      }),
    ).toEqual({ status: "failed", reason: "path" });
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });
});

describe("Grok Build server table edits", () => {
  it("edits only the Grok Build REA tables and removes them on uninstall", async () => {
    const home = await createTestTempDirectory("rea-grok-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const original = [
      "# keep this comment",
      'disabled_mcp_servers = ["xapi"]',
      "",
      "[cli]",
      'default_model = "grok-4"',
      "",
      "[mcp_servers.blender]",
      'command = "blender"',
      'args = ["--mcp"]',
      "",
      "[mcp_servers.rea]",
      'command = "old"',
      'args = ["mcp"]',
      "",
      "[mcp_servers.rea.env]",
      'OLD = "1"',
      "",
      "[[marketplace.sources]]",
      'name = "official"',
      'url = "https://example.test/market"',
      "",
      "[privacy]",
      "share = false",
      "",
    ].join("\r\n");
    await writeFile(configPath, original);
    const environment = {
      HOPPER_LAUNCHER_PATH: "/Hopper Path",
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      JAVA_HOME: "/opt/jdk-21",
    };
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        environment,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain("\r\n");
    expect(configured).toContain("# keep this comment");
    expect(configured).toContain('disabled_mcp_servers = ["xapi"]');
    expect(configured).toContain('default_model = "grok-4"');
    expect(configured).toContain("[mcp_servers.blender]");
    expect(configured).toContain('command = "blender"');
    expect(configured).toContain("[[marketplace.sources]]");
    expect(configured).toContain('name = "official"');
    expect(configured).toContain('url = "https://example.test/market"');
    expect(configured).toContain("[privacy]");
    expect(configured).toContain("share = false");
    expect(configured).toContain("[mcp_servers.rea]");
    expect(configured).toContain("startup_timeout_sec = 30");
    expect(configured).not.toContain('OLD = "1"');
    expect(configured).not.toContain('command = "old"');
    expect(parseToml(configured)).toMatchObject({
      mcp_servers: {
        blender: { command: "blender", args: ["--mcp"] },
        rea: {
          command: "rea",
          args: ["mcp"],
          startup_timeout_sec: 30,
          env: {
            JAVA_HOME: "/opt/jdk-21",
            HOPPER_LAUNCHER_PATH: "/Hopper Path",
            GHIDRA_INSTALL_DIR: "/opt/ghidra",
          },
        },
      },
      marketplace: { sources: [{ name: "official" }] },
      privacy: { share: false },
    });
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        environment,
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
    expect(await readFile(configPath, "utf8")).toBe(configured);

    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain("# keep this comment");
    expect(removed).toContain("[mcp_servers.blender]");
    expect(removed).toContain("[[marketplace.sources]]");
    expect(removed).toContain('url = "https://example.test/market"');
    expect(removed).toContain("[privacy]");
    expect(removed).not.toContain("[mcp_servers.rea]");
    expect(removed).not.toContain("startup_timeout_sec");
    expect(removed).not.toContain("JAVA_HOME");
  });
});

describe("Grok Build disabled server list", () => {
  it("removes rea from disabled_mcp_servers and leaves other names", async () => {
    const home = await createTestTempDirectory("rea-grok-disabled-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        "disabled_mcp_servers = [",
        '  "other",',
        '  "r\\u0065a",',
        '  "rea", # was off',
        '  "github",',
        "]",
        "[mcp_servers.rea]",
        "enabled = false",
        'command = "rea"',
        'args = ["mcp"]',
        "startup_timeout_sec = 30",
      ].join("\n"),
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain("# was off");
    expect(configured).not.toContain("enabled");
    expect(parseToml(configured)).toMatchObject({
      disabled_mcp_servers: ["other", "github"],
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
    await writeFile(configPath, 'disabled_mcp_servers = ["rea"] # note\n');
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const created = await readFile(configPath, "utf8");
    expect(created).toContain("# note");
    expect(created).not.toContain("disabled_mcp_servers");
    expect(parseToml(created)).toMatchObject({
      mcp_servers: { rea: { command: "rea", args: ["mcp"] } },
    });
  });
});

describe("Grok Build text that resembles a server table", () => {
  it("preserves Grok text that only looks like an REA table", async () => {
    const home = await createTestTempDirectory("rea-grok-preserve-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const original = [
      "banner = '''",
      "welcome",
      "[mcp_servers.rea]",
      "keep this text",
      "[privacy]",
      "'''",
      "",
      "[mcp_servers.rea]",
      'command = "old"',
      'args = ["mcp"]',
      "",
      "# Production server: preserve this configuration",
      '[mcp_servers."rea.env"]',
      'command = "other"',
      'args = ["serve"]',
      "",
      '[mcp_servers."other[prod]"]',
      'command = "other"',
      'args = ["serve"]',
      "",
      '[[marketplace."sources[prod]"]]',
      'name = "official"',
      "",
    ].join("\n");
    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain("keep this text");
    expect(configured).toContain(
      "# Production server: preserve this configuration",
    );
    expect(configured).toContain('[mcp_servers."rea.env"]');
    expect(configured).toContain('[mcp_servers."other[prod]"]');
    expect(configured).toContain('[[marketplace."sources[prod]"]]');
    expect(configured).not.toContain('command = "old"');
    expect(parseToml(configured)).toMatchObject({
      banner: "welcome\n[mcp_servers.rea]\nkeep this text\n[privacy]\n",
      mcp_servers: {
        "rea.env": { command: "other", args: ["serve"] },
        "other[prod]": { command: "other", args: ["serve"] },
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
      marketplace: { "sources[prod]": [{ name: "official" }] },
    });
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });

    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain("keep this text");
    expect(removed).toContain(
      "# Production server: preserve this configuration",
    );
    expect(removed).toContain('[mcp_servers."other[prod]"]');
    expect(parseToml(removed)).toMatchObject({
      mcp_servers: {
        "rea.env": { command: "other" },
        "other[prod]": { command: "other" },
      },
    });
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");
  });

  it("replaces spaced and escaped Grok REA headers without duplicating them", async () => {
    const home = await createTestTempDirectory("rea-grok-alias-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        "[ mcp_servers . rea ]",
        'command = "old"',
        'args = ["mcp"]',
        "",
        '[mcp_servers."\\u0072ea".env]',
        'OLD = "1"',
        "",
      ].join("\n"),
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).not.toContain("mcp_servers . rea");
    expect(configured).not.toContain("\\u0072ea");
    expect(configured).not.toContain('OLD = "1"');
    expect(
      configured
        .split("\n")
        .filter((line) => line.trim() === "[mcp_servers.rea]"),
    ).toHaveLength(1);
    expect(parseToml(configured)).toMatchObject({
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
  });
});

describe("Grok Build multiline and escaped headers", () => {
  it("preserves a multiline string opened on the line that closed the previous one", async () => {
    const home = await createTestTempDirectory("rea-grok-multiline-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        'banner = ["""',
        "first",
        '""", """',
        "[mcp_servers.rea]",
        'command = "keep this text"',
        "[privacy]",
        "keep this too",
        '"""]',
        "",
        "marker = ['''",
        "first",
        "''', '''",
        "[mcp_servers.rea]",
        'command = "keep literal"',
        "''']",
        "",
      ].join("\n"),
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain('command = "keep this text"');
    expect(configured).toContain("keep this too");
    expect(configured).toContain('command = "keep literal"');
    expect(parseToml(configured)).toMatchObject({
      banner: [
        "first\n",
        '[mcp_servers.rea]\ncommand = "keep this text"\n[privacy]\nkeep this too\n',
      ],
      marker: ["first\n", '[mcp_servers.rea]\ncommand = "keep literal"\n'],
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
  });

  it("replaces a hex-escaped Grok REA header and keeps a hex-escaped foreign name", async () => {
    const home = await createTestTempDirectory("rea-grok-hex-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const original = [
      '[mcp_servers."\\x72ea"]',
      'command = "rea"',
      'args = ["mcp"]',
      "",
      '[mcp_servers."rea\\x2Eenv"]',
      'command = "other"',
      'args = ["serve"]',
      "",
    ].join("\n");
    await writeFile(configPath, original);
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain('[mcp_servers."rea\\x2Eenv"]');
    expect(removed).not.toContain("\\x72");
    expect(parseToml(removed)).toMatchObject({
      mcp_servers: { "rea.env": { command: "other", args: ["serve"] } },
    });
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");

    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).not.toContain("\\x72");
    expect(configured).toContain('[mcp_servers."rea\\x2Eenv"]');
    expect(
      configured
        .split("\n")
        .filter((line) => line.trim() === "[mcp_servers.rea]"),
    ).toHaveLength(1);
    expect(parseToml(configured)).toMatchObject({
      mcp_servers: {
        "rea.env": { command: "other", args: ["serve"] },
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
  });
});

describe("Grok Build inline and dotted assignments", () => {
  it("updates and removes inline and dotted Grok REA assignments", async () => {
    const home = await createTestTempDirectory("rea-grok-assign-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const inline = [
      "[mcp_servers]",
      'rea = """',
      "[mcp_servers.rea]",
      'command = "keep? no, this is the old value"',
      '"""',
      'other = { command = "other" }',
      "",
      "# next table",
      "[privacy]",
      "share = false",
      "",
    ].join("\n");
    await writeFile(configPath, inline);
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configuredInline = await readFile(configPath, "utf8");
    expect(configuredInline).not.toContain("keep? no, this is the old value");
    expect(configuredInline).toContain('other = { command = "other" }');
    expect(configuredInline).toContain("# next table");
    expect(configuredInline).toContain("[privacy]");
    expect(parseToml(configuredInline)).toMatchObject({
      mcp_servers: {
        other: { command: "other" },
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
      privacy: { share: false },
    });
    expect(configuredInline).not.toContain("enabled");
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removedInline = await readFile(configPath, "utf8");
    expect(removedInline).toContain('other = { command = "other" }');
    expect(removedInline).toContain("# next table");
    expect(parseToml(removedInline)).not.toHaveProperty("mcp_servers.rea");

    const dotted = [
      'mcp_servers.rea = { command = "rea", args = ["mcp"] }',
      'mcp_servers.other.command = "other"',
      "",
      "# next table",
      "[privacy]",
      "share = false",
      "",
    ].join("\n");
    await writeFile(configPath, dotted);
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removedDotted = await readFile(configPath, "utf8");
    expect(removedDotted).toContain('mcp_servers.other.command = "other"');
    expect(removedDotted).toContain("# next table");
    expect(parseToml(removedDotted)).toMatchObject({
      mcp_servers: { other: { command: "other" } },
      privacy: { share: false },
    });
    expect(parseToml(removedDotted)).not.toHaveProperty("mcp_servers.rea");

    await writeFile(
      configPath,
      [
        "[mcp_servers]",
        'rea.command = "old"',
        'rea.args = ["old"]',
        'other.command = "other"',
        "",
      ].join("\n"),
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configuredDotted = await readFile(configPath, "utf8");
    expect(configuredDotted).toContain('other.command = "other"');
    expect(configuredDotted).not.toContain('rea.command = "old"');
    expect(parseToml(configuredDotted)).toMatchObject({
      mcp_servers: {
        other: { command: "other" },
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
  });
});

describe("Grok Build closed inline tables", () => {
  it("splices REA into a closed mcp_servers inline table", async () => {
    const home = await createTestTempDirectory("rea-grok-inline-table-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const original = [
      "# preamble",
      'mcp_servers = { other = { command = "other" }, "\\x72ea" = { command = "old", args = ["old"] } }',
      "",
      "# next table",
      "[privacy]",
      "share = false",
      "",
    ].join("\n");
    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain("# preamble");
    expect(configured).toContain("# next table");
    expect(configured).toContain("[privacy]");
    expect(configured).toContain("mcp_servers =");
    expect(configured).not.toMatch(/^\[mcp_servers\.rea\]$/mu);
    expect(configured).not.toContain("\\x72");
    expect(parseToml(configured)).toMatchObject({
      mcp_servers: {
        other: { command: "other" },
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
      privacy: { share: false },
    });
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });

    await writeFile(
      configPath,
      [
        'mcp_servers = { other = { command = "other" }, rea = { command = "rea", args = ["mcp"] } }',
        "",
      ].join("\n"),
    );
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain('other = { command = "other" }');
    expect(removed).toContain("mcp_servers =");
    expect(parseToml(removed)).toMatchObject({
      mcp_servers: { other: { command: "other" } },
    });
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");

    await writeFile(configPath, "mcp_servers = { }\n");
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const created = await readFile(configPath, "utf8");
    expect(created).toContain("mcp_servers =");
    expect(created).not.toMatch(/^\[mcp_servers\.rea\]$/mu);
    expect(parseToml(created)).toMatchObject({
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
  });

  it("keeps a quote that belongs to a multiline string closer", async () => {
    const home = await createTestTempDirectory("rea-grok-quotes-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        'banner = ["""keep""""]',
        "marker = ['''keep'''']",
        "[mcp_servers.rea]",
        'command = "rea"',
        'args = ["mcp"]',
        "",
      ].join("\n"),
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(parseToml(configured)).toMatchObject({
      banner: ['keep"'],
      marker: ["keep'"],
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
    expect(
      configured
        .split("\n")
        .filter((line) => line.trim() === "[mcp_servers.rea]"),
    ).toHaveLength(1);
  });
});

describe("Grok Build scalar and nested values", () => {
  it("preserves a basic string that uses the escape smol-toml accepts", async () => {
    const home = await createTestTempDirectory("rea-grok-escape-e-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        'banner = "\\e[31m"',
        "[mcp_servers.rea]",
        'command = "rea"',
        'args = ["mcp"]',
        "",
      ].join("\n"),
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain('banner = "\\e[31m"');
    expect(parseToml(configured)).toMatchObject({
      banner: "\u001b[31m",
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
  });

  it("updates a closed inline table whose last value is a scalar", async () => {
    const home = await createTestTempDirectory("rea-grok-scalar-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      'mcp_servers = { rea.command = "rea", rea.args = ["mcp"], rea.startup_timeout_sec = 10 }\n',
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).not.toMatch(/^\[mcp_servers\.rea\]$/mu);
    expect(parseToml(configured)).toMatchObject({
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
  });

  it("removes a nested array inside a Grok REA table", async () => {
    const home = await createTestTempDirectory("rea-grok-nested-array-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const original = [
      "[mcp_servers.rea]",
      'command = "rea"',
      'args = ["mcp"]',
      "extra = [",
      "  [1, 2],",
      "]",
      "",
      "[privacy]",
      "share = false",
      "",
    ].join("\n");
    await writeFile(configPath, original);
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain("[privacy]");
    expect(removed).not.toContain("[1, 2]");
    expect(parseToml(removed)).toMatchObject({ privacy: { share: false } });
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");

    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain("[privacy]");
    expect(configured).not.toContain("[1, 2]");
    expect(parseToml(configured)).toMatchObject({
      privacy: { share: false },
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
  });
});

describe("Grok Build newlines and leading marks", () => {
  it("edits a BOM-prefixed Grok document without losing the first table", async () => {
    const home = await createTestTempDirectory("rea-grok-bom-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      '\uFEFF[profile]\nmcp_servers.rea = "keep this setting"\n',
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured.startsWith("\uFEFF")).toBe(true);
    expect(configured).toContain('mcp_servers.rea = "keep this setting"');
    expect(parseToml(configured)).toMatchObject({
      profile: { mcp_servers: { rea: "keep this setting" } },
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });

    await writeFile(
      configPath,
      '\uFEFF[mcp_servers.rea]\ncommand = "rea"\nargs = ["mcp"]\n',
    );
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed.startsWith("\uFEFF")).toBe(true);
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");
  });

  it("keeps CRLF string values in a Grok file that also uses LF", async () => {
    const home = await createTestTempDirectory("rea-grok-crlf-string-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const original =
      'banner = """a\r\nb"""\n[mcp_servers.rea]\ncommand = "rea"\nargs = ["mcp"]\n';
    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    expect(parseToml(await readFile(configPath, "utf8"))).toMatchObject({
      banner: "a\r\nb",
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });

    await writeFile(configPath, original);
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(parseToml(removed)).toMatchObject({ banner: "a\r\nb" });
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");
  });

  it("keeps LF string values in a Grok file that also uses CRLF", async () => {
    const home = await createTestTempDirectory("rea-grok-mixed-newline-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      'banner = """keep\nthis LF"""\n[mcp_servers.rea]\r\ncommand = "rea"\r\nargs = ["mcp"]\r\n',
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    expect(parseToml(await readFile(configPath, "utf8"))).toMatchObject({
      banner: "keep\nthis LF",
      mcp_servers: {
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });
  });
});

describe("Grok Build inline comments", () => {
  it("keeps comments on dotted Grok fields without repeating a comma", async () => {
    const home = await createTestTempDirectory("rea-grok-dotted-comment-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const original = [
      'mcp_servers = { other = {command="other"}, # keep other note',
      '  rea.command = "rea", # command note',
      '  rea.args = ["mcp"] }',
      "",
    ].join("\n");
    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain("# keep other note");
    expect(configured).toContain("# command note");
    expect(parseToml(configured)).toMatchObject({
      mcp_servers: {
        other: { command: "other" },
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });

    await writeFile(configPath, original);
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain("# keep other note");
    expect(removed).toContain("# command note");
    expect(parseToml(removed)).toMatchObject({
      mcp_servers: { other: { command: "other" } },
    });
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");
  });

  it("keeps an inline comment that sits before the Grok REA pair", async () => {
    const home = await createTestTempDirectory("rea-grok-inline-before-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const original =
      'mcp_servers = { other = {command="other"}, # important other-server note\n  rea = {command="rea",args=["mcp"]} }\n';
    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain("# important other-server note");
    expect(parseToml(configured)).toMatchObject({
      mcp_servers: {
        other: { command: "other" },
        rea: { command: "rea", args: ["mcp"], startup_timeout_sec: 30 },
      },
    });

    await writeFile(configPath, original);
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain("# important other-server note");
    expect(parseToml(removed)).toMatchObject({
      mcp_servers: { other: { command: "other" } },
    });
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");
  });

  it("keeps inline-table comments and encodes a DEL in an inline value", async () => {
    const home = await createTestTempDirectory("rea-grok-inline-comment-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      'mcp_servers = { rea = {command="rea",args=["mcp"]}, # other: one, two\n  other = {command="other"} }\n',
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_build", configPath, format: "grok" },
        { HOPPER_LAUNCHER_PATH: "/tmp/path\u007fwith-del" },
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain("# other: one, two");
    expect(parseToml(configured)).toMatchObject({
      mcp_servers: {
        other: { command: "other" },
        rea: {
          command: "rea",
          args: ["mcp"],
          startup_timeout_sec: 30,
          env: { HOPPER_LAUNCHER_PATH: "/tmp/path\u007fwith-del" },
        },
      },
    });
  });

  it("keeps comments when uninstall removes the only inline Grok server", async () => {
    const home = await createTestTempDirectory("rea-grok-inline-empty-");
    roots.push(home);
    const configPath = join(home, ".grok/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      'mcp_servers = { # policy\n  rea = { command = "rea", args = ["mcp"] } # owned\n}\n',
    );
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain("# policy");
    expect(removed).toContain("# owned");
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");
  });
});

describe("Grok Bot configuration comments", () => {
  it("keeps a same-line JSONC comment when uninstall removes Grok Bot", async () => {
    const home = await createTestTempDirectory("rea-grokbot-jsonc-comment-");
    roots.push(home);
    const configPath = join(home, ".grokbot/mcp.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      '{\n  "mcpServers": {\n    "other": {"command":"other"}, // important other-server note\n    "rea": {"command":"rea","args":["mcp"]}\n  }\n}\n',
    );
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain("// important other-server note");
    const errors: ParseError[] = [];
    const document = parseJsonc(removed, errors, { allowTrailingComma: true });
    expect(errors).toEqual([]);
    expect(document).toEqual({
      mcpServers: { other: { command: "other" } },
    });
  });

  it("keeps a JSONC comment when a block comment precedes the comma", async () => {
    const home = await createTestTempDirectory("rea-grokbot-jsonc-block-");
    roots.push(home);
    const configPath = join(home, ".grokbot/mcp.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      '{"mcpServers":{\n  "other":{"command":"other"}, // keep other note\n  "rea":{"command":"rea","args":["mcp"]} /**/,\n  "keep":{"command":"keep"}\n}}\n',
    );
    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain("// keep other note");
    const errors: ParseError[] = [];
    const document = parseJsonc(removed, errors, { allowTrailingComma: true });
    expect(errors).toEqual([]);
    expect(document).toEqual({
      mcpServers: {
        other: { command: "other" },
        keep: { command: "keep" },
      },
    });
  });

  it("keeps a JSONC comment without swallowing the next server or closers", async () => {
    const home = await createTestTempDirectory("rea-grokbot-jsonc-next-");
    roots.push(home);
    const configPath = join(home, ".grokbot/mcp.json");
    await mkdir(dirname(configPath), { recursive: true });
    const files = [
      '{\n  "mcpServers": {\n    "other": {"command":"other"}, // important other-server note\n    "rea": {"command":"rea","args":["mcp"]}, "keep": {"command":"keep"}\n  }\n}\n',
      '{\n  "mcpServers": {\n    "other": {"command":"other"}, // important other-server note\n    "rea": {"command":"rea","args":["mcp"]}}}\n',
    ];
    for (const original of files) {
      await writeFile(configPath, original);
      expect(
        (await runUninstall(false, systemUninstallHost(home))).status,
      ).toBe("complete");
      const removed = await readFile(configPath, "utf8");
      expect(removed).toContain("// important other-server note");
      const errors: ParseError[] = [];
      const document = parseJsonc(removed, errors, {
        allowTrailingComma: true,
      });
      expect(errors).toEqual([]);
      expect(document).toMatchObject({
        mcpServers: { other: { command: "other" } },
      });
      if (original.includes('"keep"'))
        expect(document).toMatchObject({
          mcpServers: { keep: { command: "keep" } },
        });
    }
  });

  it("writes a Grok Bot stdio registration without dropping other servers", async () => {
    const home = await createTestTempDirectory("rea-grokbot-");
    roots.push(home);
    const configPath = join(home, ".grokbot/mcp.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      '{\n  // keep\n  "mcpServers": {\n    "other": { "command": "other" }\n  }\n}\n',
    );
    expect(
      await configureClientConfiguration(
        { name: "grok_bot", configPath, format: "json" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    const errors: ParseError[] = [];
    const document = parseJsonc(configured, errors, {
      allowTrailingComma: true,
    });
    expect(errors).toEqual([]);
    expect(configured).toContain("// keep");
    expect(document).toEqual({
      mcpServers: {
        other: { command: "other" },
        rea: { command: "rea", args: ["mcp"] },
      },
    });
    expect(
      await configureClientConfiguration(
        { name: "grok_bot", configPath, format: "json" },
        undefined,
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
  });
});

describe("client configuration filesystem removal", () => {
  it("uninstalls only owned entries and refuses purge symlinks", async () => {
    const home = await createTestTempDirectory("rea-uninstall-");
    roots.push(home);
    const cursor = join(home, ".cursor/mcp.json");
    const skill = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
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
    await expect(readFile(skill, "utf8")).rejects.toThrow();
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

  it("removes an owned entry through a symlink without replacing it", async () => {
    const home = await createTestTempDirectory("rea-uninstall-symlink-");
    roots.push(home);
    const configPath = join(home, ".cursor/mcp.json");
    const targetPath = join(home, "managed-mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        rea: { command: "rea", args: ["mcp"] },
        other: { command: "other" },
      },
    });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(targetPath, original);
    await symlink(targetPath, configPath);

    expect((await runUninstall(false, systemUninstallHost(home))).status).toBe(
      "complete",
    );
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(targetPath, "utf8"))).toEqual({
      mcpServers: { other: { command: "other" } },
    });
  });

  it("fails before mutation when an uninstall config symlink is dangling", async () => {
    const home = await createTestTempDirectory("rea-uninstall-symlink-");
    roots.push(home);
    const configPath = join(home, ".cursor/mcp.json");
    await mkdir(dirname(configPath), { recursive: true });
    await symlink(join(home, "missing-mcp.json"), configPath);

    const result = await runUninstall(false, systemUninstallHost(home));
    expect(result.status).toBe("failed");
    expect(result.items).toContainEqual({
      name: "cursor",
      status: "failed",
      detail:
        "Configuration path could not be safely verified. Check its permissions and, if it is a symbolic link, verify that the link resolves to a regular file owned by the current user, then rerun uninstall.",
    });
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });

  it("fails closed on malformed client configuration", async () => {
    const home = await createTestTempDirectory("rea-uninstall-bad-");
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
});

describe("client configuration filesystem failure reporting", () => {
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
    const home = await createTestTempDirectory("rea-uninstall-remove-");
    roots.push(home);
    const skillRoot = join(home, ".agents/skills/reverse-engineer-anything");
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
  realpath: (path) => realpath(path),
  remove: (path) => rm(path, { recursive: true }),
};

const uninstallFixture = async (): Promise<{
  readonly home: string;
  readonly config: string;
}> => {
  const home = await createTestTempDirectory("rea-uninstall-failure-");
  roots.push(home);
  const config = join(home, ".cursor/mcp.json");
  await mkdir(dirname(config), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { rea: { command: "rea", args: ["mcp"] } } }),
  );
  return { home, config };
};
